import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFailures, repairTail } from "../internal/session.ts";

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

test("the session file is where a failed model request is still visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-session-"));
  const file = join(dir, "2026-11-04T03-59-56-889Z_geng-alice-0006.jsonl");
  const assistant = (stopReason: string, content: unknown[]) =>
    JSON.stringify({ type: "message", message: { role: "assistant", content, stopReason } });
  writeFileSync(
    file,
    [
      assistant("end", [{ type: "text", text: "开始" }]),
      assistant("error", []),
      assistant("error", []),
      JSON.stringify({ type: "message", message: { role: "user", content: "说的是人话" } }),
      "",
    ].join("\n"),
  );
  // two failures, and the last assistant message is one of them
  assert.deepEqual(modelFailures(file), { count: 2, last: true });

  // a round that recovered ends on words, however many times it stumbled
  writeFileSync(file, [assistant("error", []), assistant("end", [{ type: "text", text: "好了" }]), ""].join("\n"));
  assert.deepEqual(modelFailures(file), { count: 1, last: false });

  // nothing to read is not a failure: an absent file must not become a symptom
  assert.deepEqual(modelFailures(join(dir, "nope.jsonl")), { count: 0, last: false });
});
