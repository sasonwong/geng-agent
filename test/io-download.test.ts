import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToFile } from "../image/extensions/lib/uds.ts";

// getToFile 只认 socketPath。Windows 不能把 server 绑到普通文件路径（EACCES），命名管道
// 可以，于是 Windows 用 \\.\pipe\...、POSIX 用临时目录里的 .sock；两端都用同一个路径。
function newSocket(): { sock: string; clean: () => void } {
  if (process.platform === "win32") {
    const sock = `\\\\.\\pipe\\geng-io-dl-${process.pid}-${Math.random().toString(36).slice(2)}`;
    return { sock, clean: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "geng-io-dl-"));
  return { sock: join(dir, "s.sock"), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ sock: string; close: () => Promise<void> }> {
  const { sock, clean } = newSocket();
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => resolve());
  });
  return {
    sock,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      clean();
    },
  };
}

function destPaths(tag: string): { dir: string; dest: string; part: string } {
  const dir = mkdtempSync(join(tmpdir(), `geng-io-dest-${tag}-`));
  const dest = join(dir, "out.bin");
  return { dir, dest, part: `${dest}.geng-part-${process.pid}` };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("等超时了");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 等 part 文件连续一阵子都不存在。createWriteStream 的 open 是异步的：一次很快的失败
 * 里，fail 里的 cleanup 可能撞上还没打开的句柄，open 随后又把 part 建回来，直到 close
 * 才被清掉。只看「某一刻不在」会在 open 之前的空窗里误判成已经清干净。
 */
async function waitForGone(path: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  let quiet = 0;
  while (Date.now() < until) {
    if (existsSync(path)) {
      quiet = 0;
    } else if (++quiet >= 12) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${path} 一直没清掉`);
}

/** 一个 body 说到一半就把连接掐断的响应：客户端只会看到 aborted / error，不会看到 end。 */
function cutShort(res: ServerResponse): void {
  res.writeHead(200, { "content-length": "100", "content-type": "application/octet-stream" });
  res.write("short", () => res.socket?.destroy());
}

test("getToFile 完整下载：返回字节数，part 被 rename 成 dest", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from([0, 1, 2, 255]));
  });
  const { dir, dest, part } = destPaths("ok");
  try {
    const r = await getToFile(s.sock, "/files/F1", dest, 5000);
    assert.equal(r.status, 200);
    assert.equal(r.bytes, 4);
    assert.deepEqual([...readFileSync(dest)], [0, 1, 2, 255]);
    assert.equal(existsSync(part), false, "成功后 part 要被 rename 掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("getToFile 先写 part 文件，dest 只在 finish 时出现", async () => {
  // 旧代码直接 createWriteStream(dest)：下载还没完，dest 就带着半截字节出现在盘上，
  // 之后会被当成整份文件发出去。新代码只把字节写进 part，finish 才 rename 成 dest。
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const s = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write("abc");
    void gate.then(() => res.end("def"));
  });
  const { dir, dest, part } = destPaths("mid");
  let pending: Promise<{ status: number; bytes: number }> | undefined;
  try {
    pending = getToFile(s.sock, "/files/F1", dest, 5000);
    // 等到客户端真的开始写文件了再断言：part 或 dest 出现任一即可。
    await waitFor(() => existsSync(part) || existsSync(dest));
    assert.equal(existsSync(dest), false, "下载没完时 dest 不该存在");
    assert.ok(existsSync(part), "字节要落在 part 文件里");
    release();
    const r = await pending;
    assert.equal(r.bytes, 6);
    assert.equal(readFileSync(dest, "utf8"), "abcdef");
    assert.equal(existsSync(part), false, "rename 之后 part 要消失");
  } finally {
    release();
    if (pending !== undefined) {
      await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("失败的重下不动 dest 里原有的好文件，并清掉 part", async () => {
  // 旧行为：任何失败都 rmSync(dest, {force:true})，一次没下完就把原来那份好文件删了。
  // 而且旧代码一上来就 createWriteStream(dest) 截断 dest，连半截都不会留下。
  const s = await serve((_req, res) => cutShort(res));
  const { dir, dest, part } = destPaths("keep");
  writeFileSync(dest, "ORIGINAL-GOOD");
  try {
    await assert.rejects(() => getToFile(s.sock, "/files/F1", dest, 5000));
    assert.equal(readFileSync(dest, "utf8"), "ORIGINAL-GOOD", "失败的重下不能删掉原来的好文件");
    await waitForGone(part);
    assert.equal(existsSync(part), false, "part 文件要被清掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("截断的 body 不会变成一份看着完整的 dest", async () => {
  const s = await serve((_req, res) => cutShort(res));
  const { dir, dest, part } = destPaths("cut");
  try {
    await assert.rejects(() => getToFile(s.sock, "/files/F1", dest, 5000));
    assert.equal(existsSync(dest), false, "半截 body 不能被当成整份文件落到 dest");
    // the same async-open race the other tests here use waitForGone for: under a loaded
    // suite, one snapshot "not there yet" is not the same as "cleaned up"
    await waitForGone(part);
    assert.equal(existsSync(part), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("非 200 只报错，不碰 dest", async () => {
  const s = await serve((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "没有这个文件：F9" }));
  });
  const { dir, dest, part } = destPaths("404");
  writeFileSync(dest, "ORIGINAL-GOOD");
  try {
    await assert.rejects(() => getToFile(s.sock, "/files/F9", dest, 5000), /取不到/);
    assert.equal(readFileSync(dest, "utf8"), "ORIGINAL-GOOD", "404 也不能删掉 dest");
    assert.equal(existsSync(part), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});


