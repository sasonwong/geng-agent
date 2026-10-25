import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWaiting } from "../internal/schedule.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const f = join(dir, "waiting.json");
  writeFileSync(f, content);
  return f;
}

test("a relative alarm counts from when it was written, not from when it is read", () => {
  const f = tmpFile(JSON.stringify({ wake: { after: "20m" }, why: "等 CI" }));
  const writtenAt = statSync(f).mtimeMs;
  const spec = readWaiting(f);
  assert.equal(spec?.dueAtMs, writtenAt + 20 * 60_000);
  assert.equal(spec?.why, "等 CI");

  // an alarm that came due while the machine was off is already overdue
  assert.ok((spec?.dueAtMs ?? Infinity) < writtenAt + 21 * 60_000);
});

test("readWaiting parses an absolute alarm", () => {
  const f = tmpFile(JSON.stringify({ wake: { at: "2026-03-02T01:00:00Z" } }));
  assert.equal(readWaiting(f)?.dueAtMs, Date.parse("2026-03-02T01:00:00Z"));
});

test("readWaiting returns null when no alarm was set", () => {
  assert.equal(readWaiting(join(tmpdir(), "geng-no-such-file.json")), null);
  assert.equal(readWaiting(tmpFile("{not json")), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ why: "我忘了" }))), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ wake: { after: "20 minutes" } }))), null);
});
