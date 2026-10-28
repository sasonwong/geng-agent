import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alarmSpent, knockFloorMs, knockable, readWaiting } from "../internal/schedule.ts";

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

test("a message already handed over does not knock again inside the floor", () => {
  const hold = { files: ["chat-1.json"], untilMs: 1_000 };
  assert.equal(knockable([], hold, 0), false, "nothing pending cannot knock");
  assert.equal(knockable(["chat-1.json"], hold, 0), false, "the same words again wait");
  assert.equal(knockable(["chat-1.json"], hold, 1_000), true, "the floor expires");
  assert.equal(knockable(["chat-2.json"], hold, 0), true, "a new message does not queue behind it");
  assert.equal(knockable(["chat-1.json"], null, 0), true, "no floor set: knock as before");
});

test("an alarm is spent only once its moment arrives", () => {
  const due = Date.parse("2026-03-02T01:00:00Z");
  const alarm = { dueAtMs: due, why: "等 CI" };
  assert.equal(alarmSpent(alarm, due - 1), false, "an earlier knock must not cancel the alarm");
  assert.equal(alarmSpent(alarm, due), true, "a wake at the appointed time spends it");
  assert.equal(alarmSpent(null, due), false, "no alarm: nothing to spend");
});

test("a batch that keeps failing waits like a timer, not a minute", () => {
  const minMs = 60_000;
  assert.equal(knockFloorMs(true, minMs, 2 * 60 * 60_000), minMs, "a clean round: one minute");
  assert.equal(knockFloorMs(false, minMs, 2 * 60 * 60_000), 2 * 60 * 60_000, "a failed one: the backoff");
  assert.equal(knockFloorMs(false, minMs, 0), minMs, "no backoff yet: still the floor");
});
