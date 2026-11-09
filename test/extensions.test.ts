import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// These files run inside the container, not here: tsconfig does not include image/, and the
// pi packages they import resolve only in the image. So `npm run check` never looks at them,
// and since they are mounted, an edit lands on the next waking — a file that does not parse
// makes pi exit 1 before it can speak, on every waking after that. Syntax only, deliberately:
// no libs, no module resolution, no types.
test("every tool in image/extensions/ parses", () => {
  const dir = fileURLToPath(new URL("../image/extensions/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
  assert.ok(files.length > 0, `${dir} 里没有任何工具：挂载进容器的会是一个空目录`);

  const program = ts.createProgram({
    rootNames: files,
    options: { noEmit: true, noLib: true, noResolve: true, types: [], skipLibCheck: true },
  });
  const errors = program.getSyntacticDiagnostics().map((d) => {
    const where = d.file ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "?";
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
  assert.deepEqual(errors, [], `这些工具解析不了，pi 会带着它们 exit 1:\n${errors.join("\n")}`);
});

// `-e` loads every top-level file in the mounted directory, and an extension that does not
// export a default makes pi exit 1 before it can speak — on every waking. A helper belongs
// in a subdirectory, which `extensionArgs` skips; this is the check that says so out loud.
test("every loaded file is an extension, and shared code lives one level down", () => {
  const dir = fileURLToPath(new URL("../image/extensions/", import.meta.url));
  const top = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name);
  assert.ok(top.length > 0);
  for (const name of top) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.match(
      source,
      /export default function/,
      `${name} 被当成扩展加载，但没有 export default：pi 会带着它 exit 1`,
    );
  }
});

// Syntax is not the whole risk. An extension that parses but references a name that no
// longer exists throws while pi is loading it, and pi exits 1 before it can speak — every
// waking, with the round logged as `sym=start-failed` and no hint about which file.
// 2304 is exactly that class ("Cannot find name"); module resolution and the `.ts` import
// rule cannot be checked here (the image's packages are not installed in this checkout),
// so they are filtered out rather than allowed to hide the one that matters.
test("no extension refers to a name that only exists in a previous version", () => {
  const dir = fileURLToPath(new URL("../image/extensions/", import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
  const program = ts.createProgram({
    rootNames: files,
    options: {
      noEmit: true,
      allowImportingTsExtensions: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: ["node"],
    },
  });
  const undefined_ = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .filter((d) => d.code === 2304)
    .map((d) => {
      const where = d.file
        ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
        : "?";
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  assert.deepEqual(undefined_, [], `这些名字不存在，pi 会在加载扩展时 exit 1:\n${undefined_.join("\n")}`);
});

// The one safety check on the download tool, exercised without pi: a path the model
// chose must not become a way to write outside the directory it was given.
test("a download lands where the model said, or nowhere", async () => {
  const { resolveUnder } = await import("../image/extensions/lib/under.ts");
  assert.equal(resolveUnder("/work", "/work/in/a.png"), "/work/in/a.png");
  assert.equal(resolveUnder("/work", "in/a.png"), "/work/in/a.png");
  assert.equal(resolveUnder("/work", "/work/../state/identity.md"), null);
  assert.equal(resolveUnder("/work", "/etc/passwd"), null);
  // the directory itself is inside itself; a file cannot be written *as* the directory
  assert.equal(resolveUnder("/work", "/work"), "/work");
});

test("a link left behind in the writable directory cannot point a download out of it", async () => {
  const { resolveUnder } = await import("../image/extensions/lib/under.ts");
  // posix.resolve 只认以 `/` 开头的绝对路径；把 Windows 的盘符去掉后，Node 在
  // Windows 上仍会把这个 `/...` 解到同一个目录（当前盘的根）。
  const real = mkdtempSync(join(tmpdir(), "geng-under-"));
  const root = real.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  try {
    // Windows 上目录符号链接要提权，junction 不用；两边都只要 lstat 能看出它是链接。
    symlinkSync(real, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolveUnder(root, `${root}/plain/x.txt`), `${root}/plain/x.txt`);
    assert.equal(resolveUnder(root, `${root}/link/x.txt`), null, "顺着上一轮留下的链接写出去了");
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

// image/ is outside the tsconfig program and the extension's pi imports resolve only in
// the image, so this import is a runtime one: a literal specifier would make `npm run
// check` follow a module it cannot resolve. What is pinned is the event name — `pi.on()`
// takes any string, and a typo makes the hook never fire while nothing reports it.
test("the compact hook is registered on the event pi fires, and passes the fold through", async () => {
  const specifier: string = "../image/extensions/compact.ts";
  const { default: compact } = (await import(specifier)) as {
    default: (pi: { on: (event: string, handler: (e: unknown) => unknown) => void }) => void;
  };
  let event = "";
  let handler: ((e: unknown) => unknown) | undefined;
  compact({
    on: (name, h) => {
      event = name;
      handler = h;
    },
  });
  assert.equal(event, "session_before_compact", "写错事件名时钩子不触发，只会安静地退回付费摘要");
  assert.ok(handler);

  const result = handler({
    preparation: {
      messagesToSummarize: [{ role: "user", content: "本轮：把那封信回掉" }],
      turnPrefixMessages: [{ role: "user", content: "插一句" }],
      firstKeptEntryId: "entry-7",
      tokensBefore: 1234,
    },
    branchEntries: [{ type: "message", message: { role: "user", content: "本轮：把那封信回掉" } }],
  }) as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } };
  assert.deepEqual(Object.keys(result.compaction).sort(), [
    "firstKeptEntryId",
    "summary",
    "tokensBefore",
  ]);
  assert.equal(result.compaction.firstKeptEntryId, "entry-7");
  assert.equal(result.compaction.tokensBefore, 1234);
  assert.match(result.compaction.summary, /本轮：把那封信回掉/);
  assert.match(result.compaction.summary, /早先的 2 条消息已折叠/);
});
