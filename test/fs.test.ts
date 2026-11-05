import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine } from "../internal/fs.ts";


test("a log that only grows keeps one previous copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-fs-"));
  const file = join(dir, "net.log");
  for (let i = 1; i <= 5; i++) appendLine(file, `line ${i}`, 2);
  // a rotation happens *before* the write that would exceed the limit, so neither file
  // ever holds more than `max` lines and nothing is lost
  assert.deepEqual(
    readFileSync(file, "utf8").trim().split("\n"),
    ["line 5"],
  );
  assert.deepEqual(
    readFileSync(`${file}.1`, "utf8").trim().split("\n"),
    ["line 3", "line 4"],
  );
  // one previous copy is the whole promise: the total on disk is bounded at 2×max, and
  // what falls off the end is oldest — the trade a log file makes
  const total = (readFileSync(`${file}.1`, "utf8") + readFileSync(file, "utf8")).trim().split("\n");
  assert.ok(total.length <= 4, `盘上最多 2×max 行，实际 ${total.length}`);
  assert.deepEqual(total, ["line 3", "line 4", "line 5"]);
});
