import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTENTION_MAX_MS, attentionActive, parseAttention, readAttention } from "../internal/attention.ts";

const now = Date.parse("2026-10-26T15:00:00Z");
const H = 3_600_000;
const eightHours = new Date(now + 8 * H).toISOString();

test("a window covers only the chats it names, and only until it ends", () => {
  const a = parseAttention({ chats: [-100], until: "2026-10-26T16:00:00Z" }, now, now);
  assert.ok(a);
  assert.equal(attentionActive(a, -100, now), true);
  assert.equal(attentionActive(a, -200, now), false);
  assert.equal(attentionActive(a, -100, Date.parse("2026-10-26T16:00:01Z")), false);
  assert.equal(attentionActive(parseAttention({ chats: ["*"], until: "2026-10-26T16:00:00Z" }, now, now), -200, now), true);
});

test("a window asking for longer than four hours is cut off at the moment it was written", () => {
  // The cap is written by `listen`, but the file is the instance's own; reading it is the
  // last place the rule can be kept.
  const a = parseAttention({ chats: ["*"], until: eightHours }, now, now);
  assert.ok(a);
  assert.equal(a.untilMs, now + ATTENTION_MAX_MS);
});

test("re-reading the same window later does not hand back the hours the cap took", () => {
  // The gateway's shape: it parses the file again on every message. Anchoring the cap at
  // the reading instant instead of the writing one passes the test above and fails here —
  // `min(until, now + MAX)` is above `now` for every window that was ever written.
  for (const later of [0, 1, 4, 7]) {
    const at = now + later * H;
    const a = parseAttention({ chats: ["*"], until: eightHours }, at, now);
    assert.ok(a);
    assert.equal(a.untilMs, now + ATTENTION_MAX_MS);
    assert.equal(attentionActive(a, -200, at), at < now + ATTENTION_MAX_MS);
  }
});

test("a write that has not happened yet is not a window at all", () => {
  // `touch -d tomorrow` is the same one-liner as `echo`, and it would move the anchor past
  // the cap. The state dir is the instance's own; the clock is not.
  assert.equal(parseAttention({ chats: ["*"], until: eightHours }, now, now + H), null);
});

test("a window inside the cap keeps exactly the time it was given", () => {
  const ninety = new Date(now + 90 * 60_000).toISOString();
  const a = parseAttention({ chats: [-100], until: ninety }, now, now);
  assert.ok(a);
  assert.equal(a.untilMs, Date.parse(ninety));
});

test("the anchor is the file's own mtime, not the moment it is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-attention-"));
  const file = join(dir, "attention.json");
  writeFileSync(file, JSON.stringify({ chats: ["*"], until: eightHours }));
  utimesSync(file, new Date(now), new Date(now)); // as if it was written at `now`
  const read = readAttention(file, now + 7 * H);
  assert.ok(read);
  assert.equal(read.untilMs, now + ATTENTION_MAX_MS);
  assert.equal(attentionActive(read, -200, now + 7 * H), false);
  assert.equal(readAttention(join(dir, "missing.json"), now), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a broken or empty window is no window, never an error", () => {
  assert.equal(parseAttention(null, now, now), null);
  assert.equal(parseAttention({ chats: [], until: "2026-10-26T16:00:00Z" }, now, now), null);
  assert.equal(parseAttention({ chats: [-100], until: "不是时间" }, now, now), null);
  assert.equal(parseAttention({ chats: ["x"], until: "2026-10-26T16:00:00Z" }, now, now), null);
  assert.equal(attentionActive(null, -100, now), false);
});
