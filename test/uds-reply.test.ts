import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 扩展不 import pi 的运行时代码（见 lib/tool.ts），所以这里能直接把它们加载起来、
// 用一个假的 registerTool 接住，再调一次工具。比读源码断言强的地方是：它验的是
// 「这一轮还会不会有一句话」，不是「有没有写 try」。
//
// 旧行为：say-mute 把死掉的 socket 回成一句话，book / recall / websearch 却把
// postJson 的异常直接抛出去，连空 socket 都抛。宿主暂时没起来，本来只该在纸上
// 多一行字，结果整轮醒来以异常收场——和 docs/install.md 里「只在调用时回一句话」
// 说的是两回事。

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DEAD = join(tmpdir(), `geng-no-such-book-${process.pid}.sock`);

type Tool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }>;
};

async function load(file: string, env: Record<string, string>, tag: string): Promise<Tool[]> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    // query 让每个用例拿到一份新模块：SOCKET 是在模块顶层读的，不这样的话
    // 第二个用例会接着用第一个用例的环境变量。
    const mod = await import(`../image/extensions/${file}?case=${tag}`);
    const tools: Tool[] = [];
    mod.default({ registerTool: (t: Tool) => tools.push(t) });
    return tools;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CASES = [
  { file: "book.ts", env: "GENG_BOOK_SOCK", tool: "journal", params: { texts: ["hi"] } },
  { file: "recall.ts", env: "GENG_BOOK_SOCK", tool: "recall", params: {} },
  { file: "say-mute.ts", env: "GENG_BOOK_SOCK", tool: "say", params: { messages: ["hi"] } },
  { file: "websearch.ts", env: "GENG_SEARCH_SOCKET", tool: "web_search", params: { query: "hi" } },
] as const;

test("postJson rejects on a dead host, and postJsonOrError turns that into a reply", async () => {
  const { postJson, postJsonOrError } = await import("../image/extensions/lib/uds.ts");
  await assert.rejects(() => postJson(DEAD, "/journal", { texts: ["x"] }), /没有东西在听/);
  const r = await postJsonOrError(DEAD, "/journal", { texts: ["x"] });
  assert.equal(r.status, 0);
  assert.match((JSON.parse(r.body) as { error: string }).error, /宿主上的服务没起来/);
});

for (const [i, c] of CASES.entries()) {
  test(`${c.file}: a host that is not listening is a sentence, not an exception`, async () => {
    const tools = await load(c.file, { [c.env]: DEAD }, `dead-${i}`);
    const t = tools.find((x) => x.name === c.tool);
    assert.ok(t, `${c.tool} 没注册`);
    const r = await t.execute("call-1", c.params);
    assert.equal(r.content.length, 1, "工具要回一句话");
    assert.match(r.content[0]?.text ?? "", /宿主上的服务没起来/);
  });

  test(`${c.file}: a missing socket is reported in words too`, async () => {
    const tools = await load(c.file, { [c.env]: "" }, `empty-${i}`);
    if (c.file === "websearch.ts") {
      // 这是唯一的例外，也是文档写明的：搜索端点没挂进来时两个工具干脆不注册。
      assert.equal(tools.length, 0);
      return;
    }
    const t = tools.find((x) => x.name === c.tool);
    assert.ok(t, `${c.tool} 没注册`);
    const r = await t.execute("call-1", c.params);
    assert.match(r.content[0]?.text ?? "", /没有配置/);
  });
}

test("no tool throws its own missing-endpoint error", () => {
  for (const c of CASES) {
    const src = readFileSync(join(REPO, "image", "extensions", c.file), "utf8");
    assert.equal(/throw new Error\("没有配置/.test(src), false, `${c.file} 还在抛`);
  }
});
