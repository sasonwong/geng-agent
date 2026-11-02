import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
