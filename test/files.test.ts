import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareName, filesUsage, forgetFiles, parseForget, pruneFiles } from "../internal/files.ts";

const NOW = Date.parse("2026-03-02T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "geng-test-"));
}

function put(root: string, name: string, kb: number, ageDays: number): void {
  writeFileSync(join(root, name), "x".repeat(kb * 1024));
  const when = new Date(NOW - ageDays * day);
  utimesSync(join(root, name), when, when);
}

test("the cap takes the oldest first, and leaves the newest alone", () => {
  const d = dir();
  put(d, "old.bin", 600, 10);
  put(d, "mid.bin", 600, 5);
  put(d, "new.bin", 600, 1);

  const r = pruneFiles(d, { maxMb: 1, maxAgeDays: 0 }, NOW);
  assert.equal(r.removed, 2);
  assert.equal(Math.round((NOW - (r.oldestRemovedMs ?? 0)) / day), 10);
  // one file survives even though it alone is under the cap: the newest is never the one
  // the daemon decides to throw away
  assert.equal(statSync(join(d, "new.bin")).size, 600 * 1024);
});

test("an age of 0 means the age rule is off", () => {
  const d = dir();
  put(d, "ancient.bin", 1, 999);
  put(d, "fresh.bin", 1, 0);
  assert.equal(pruneFiles(d, { maxMb: 500, maxAgeDays: 0 }, NOW).removed, 0);
  assert.equal(pruneFiles(d, { maxMb: 500, maxAgeDays: 30 }, NOW).removed, 1);
  assert.equal(statSync(join(d, "fresh.bin")).size, 1024);
});

test("forgetting takes only bare names inside the directory", () => {
  const d = dir();
  put(d, "a.jpg", 1, 0);
  put(d, "b.jpg", 1, 0);
  assert.equal(bareName("/files/a.jpg"), "a.jpg");
  assert.equal(bareName("../policy.json"), null);
  assert.equal(bareName("/files/sub/a.jpg"), null);
  assert.equal(forgetFiles(d, ["/files/a.jpg", "/files/../policy.json"]), 1);
  assert.equal(filesUsage(d).count, 1);
  // a name that matches nothing is not a removal: `rmSync(force)` never throws, so the
  // count used to include it and the page said "删了 3 个" over one deleted file
  assert.equal(forgetFiles(d, ["/files/gone.jpg", "F12"]), 0, "只在真删掉东西的时候算一个");
});

test("a name containing two dots is still a name, not a path", () => {
  // `includes("..")` refused ordinary attachment names: `forget` then reported a
  // deletion over a file that was still sitting in files/.
  assert.equal(bareName("F12-1-report..pdf"), "F12-1-report..pdf");
  assert.equal(bareName(".."), null);
  assert.equal(bareName("."), null);
  assert.equal(bareName("..\\policy.json"), null);
});

test("a dry prune reports the bytes a real round would leave, without deleting", () => {
  const d = dir();
  put(d, "old.bin", 600, 10);
  put(d, "mid.bin", 600, 5);
  put(d, "new.bin", 600, 1);

  const preview = pruneFiles(d, { maxMb: 1, maxAgeDays: 0 }, NOW, false);
  assert.equal(preview.removed, 2);
  assert.equal(filesUsage(d).count, 3, "预览一个文件都没删");
  const real = pruneFiles(d, { maxMb: 1, maxAgeDays: 0 }, NOW);
  assert.equal(real.removed, 2);
  assert.equal(preview.bytesLeft, filesUsage(d).bytes, "预览报的剩余量和真跑之后一样");
});

test("a directory in files/ is not counted as a file", () => {
  const d = dir();
  put(d, "a.bin", 1, 0);
  mkdirSync(join(d, "stray"));
  const u = filesUsage(d);
  assert.equal(u.count, 1, "只有真正称过重量的才算一个文件");
  assert.equal(u.bytes, 1024);
});

test("a malformed request deletes nothing", () => {
  assert.deepEqual(parseForget(null), []);
  assert.deepEqual(parseForget({ files: "x" }), []);
  assert.deepEqual(parseForget({ files: ["/files/a", 3] }), ["/files/a"]);
});
