import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { ensureDirs } from "../internal/fs.ts";
import { allocate } from "../internal/ids.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("two processes handing out ids never hand out the same one", async () => {
  // The ids file is read-modify-write, and the gateway and the mail endpoint do it at
  // the same time: both read the same counter, both handed out the same number, and
  // `fileById` answered with whichever of the two files it listed first.
  const root = mkdtempSync(join(tmpdir(), "geng-ids-"));
  const p = makePaths(root, "alice");
  ensureDirs(requiredDirs(p));

  const code = `
const { allocate } = await import(${JSON.stringify(pathToFileURL(join(REPO, "internal", "ids.ts")).href)});
const { makePaths } = await import(${JSON.stringify(pathToFileURL(join(REPO, "internal", "paths.ts")).href)});
const p = makePaths(process.argv[1], process.argv[2]);
const out = [];
for (let i = 0; i < 20; i++) out.push(allocate(p, "file").n);
process.stdout.write(JSON.stringify(out));
`;
  const run = (): Promise<number[]> =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", code, root, "alice"],
        { timeout: 60_000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(JSON.parse(String(stdout)) as number[]);
        },
      );
    });
  const [a, b] = await Promise.all([run(), run()]);
  const overlap = a.filter((n) => b.includes(n));
  assert.deepEqual(overlap, [], `两个进程发到了同一个号：${overlap.join("、")}`);
});

test("a lock whose holder is long gone is taken over, not waited on", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-ids-"));
  const p = makePaths(root, "bob");
  ensureDirs(requiredDirs(p));
  // a corpse from a crashed process: older than any allocation can take
  const lock = `${p.ids}.lock`;
  writeFileSync(lock, "stale");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const { id } = allocate(p, "loop");
  assert.match(id, /^L\d+$/);
  assert.equal(existsSync(lock), false, "拿走陈锁之后要删掉它");
});
