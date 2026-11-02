import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionActive, parseAttention } from "../internal/attention.ts";

const now = Date.parse("2026-10-26T15:00:00Z");

test("a window covers only the chats it names, and only until it ends", () => {
  const a = parseAttention({ chats: [-100], until: "2026-10-26T16:00:00Z" });
  assert.ok(a);
  assert.equal(attentionActive(a, -100, now), true);
  assert.equal(attentionActive(a, -200, now), false);
  assert.equal(attentionActive(a, -100, Date.parse("2026-10-26T16:00:01Z")), false);
  assert.equal(attentionActive(parseAttention({ chats: ["*"], until: "2026-10-26T16:00:00Z" }), -200, now), true);
});

test("a window asking for longer than four hours is cut off when read", () => {
  // The cap is written by `listen`, but the file is the instance's own; reading it is
  // the last place the rule can be kept.
  const eightHours = new Date(now + 8 * 3_600_000).toISOString();
  const a = parseAttention({ chats: ["*"], until: eightHours }, now);
  assert.ok(a);
  assert.equal(attentionActive(a, -200, now), true);
  assert.equal(attentionActive(a, -200, now + 4 * 3_600_000 - 1), true);
  assert.equal(attentionActive(a, -200, now + 4 * 3_600_000), false);
  assert.equal(attentionActive(a, -200, now + 7 * 3_600_000), false);
});

test("a window inside the cap keeps exactly the time it was given", () => {
  const ninety = new Date(now + 90 * 60_000).toISOString();
  const a = parseAttention({ chats: [-100], until: ninety }, now);
  assert.ok(a);
  assert.equal(a.untilMs, Date.parse(ninety));
});

test("a broken or empty window is no window, never an error", () => {
  assert.equal(parseAttention(null), null);
  assert.equal(parseAttention({ chats: [], until: "2026-10-26T16:00:00Z" }), null);
  assert.equal(parseAttention({ chats: [-100], until: "不是时间" }), null);
  assert.equal(parseAttention({ chats: ["x"], until: "2026-10-26T16:00:00Z" }), null);
  assert.equal(attentionActive(null, -100, now), false);
});
