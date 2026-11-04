import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
