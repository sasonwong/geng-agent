import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairTail } from "../internal/session.ts";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const f = join(dir, name);
  writeFileSync(f, content);
  return f;
}

test("repairTail leaves a clean file untouched", () => {
  const f = tmpFile("s.jsonl", '{"a":1}\n{"b":2}\n');
  const r = repairTail(f, true);
  assert.equal(r.repairedLines, 0);
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n{"b":2}\n');
});

test("repairTail drops a half-written final line", () => {
  const f = tmpFile("s.jsonl", '{"a":1}\n{"b":2}\n{"c":');
  const r = repairTail(f, true);
  assert.equal(r.repairedLines, 1);
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n{"b":2}\n');
});

test("repairTail reports without writing when fix=false", () => {
  const f = tmpFile("s.jsonl", '{"a":1}\n garbage');
  const r = repairTail(f, false);
  assert.equal(r.repairedLines, 0);
  assert.match(r.note, /1 行/);
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n garbage');
});
