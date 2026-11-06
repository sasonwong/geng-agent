import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeState } from "../internal/dev/fake.ts";
import { makePaths } from "../internal/paths.ts";
import { countLoops } from "../internal/packet.ts";
import { writeJson, writeText } from "../internal/fs.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { runDaemon } from "../internal/daemon.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Paths plus contents: a preview that only renames a file must still be caught. */
function snapshot(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split("\\").join("/");
      if (e.isDirectory()) {
        rows.push(`d ${rel}`);
        walk(full);
      } else if (e.isFile()) {
        rows.push(`f ${rel} ${readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(dir);
  return rows.join("\n");
}

test("the fake state has the shape the page reads: one file per unfinished thing", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-fake-"));
  try {
    const p = makePaths(root, "alice");
    writeFakeState(p);
    // this used to be a JSON array written over the directory, so `geng-dev packet` died
    // on ensureDirs (EEXIST) and the page, when it did build, counted nothing
    assert.equal(countLoops(p), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the packet preview changes nothing on disk, even with work waiting to be done", async () => {
  // `geng-dev packet` is a preview of a *real* instance. It used to consume a forget
  // request, delete the files, quarantine a broken inbox message, prune old files,
  // rewrite a torn session tail, create the ops outbox and even `docker kill` orphan
  // containers — all before it printed the page.
  const root = mkdtempSync(join(tmpdir(), "geng-dry-"));
  try {
    const p = makePaths(root, "alice");
    writeText(
      join(root, "deploy", "SYSTEM.md"),
      readFileSync(join(REPO, "deploy", "SYSTEM.md"), "utf8"),
    );
    writeFakeState(p);
    const policy = defaultPolicy();
    policy.files.maxAgeDays = 1; // so the prune pass has something to say
    writeJson(p.policy, policy);

    // three files: one asked to be forgotten, one old enough to prune, one newest
    writeText(join(p.filesDir, "F1.txt"), "forget me");
    writeText(join(p.filesDir, "F2.txt"), "prune me");
    writeText(join(p.filesDir, "F3.txt"), "keep me");
    const old = new Date(0);
    utimesSync(join(p.filesDir, "F1.txt"), old, old);
    utimesSync(join(p.filesDir, "F2.txt"), old, old);
    writeJson(p.filesForget, { files: ["F1.txt"] });
    writeText(join(p.inbox, "broken.json"), "{not json");
    writeText(join(p.sessionDir, "geng-alice-0001.jsonl"), '{"ok":1}\n{"torn');

    const before = snapshot(root);
    const said: string[] = [];
    await runDaemon({
      root,
      instance: "alice",
      once: true,
      dry: true,
      log: (line) => { said.push(line); },
    });
    const page = said.join("\n");
    assert.equal(snapshot(root), before, "a preview must not eat what it is showing");
    assert.match(page, /按你说的删了 1 个文件/, "the preview still reports the forget pass");
    assert.match(page, /清掉 1 个最老的/, "and does not count the forgotten file a second time");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
