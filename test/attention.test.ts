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

test("a broken or empty window is no window, never an error", () => {
  assert.equal(parseAttention(null), null);
  assert.equal(parseAttention({ chats: [], until: "2026-10-26T16:00:00Z" }), null);
  assert.equal(parseAttention({ chats: [-100], until: "不是时间" }), null);
  assert.equal(parseAttention({ chats: ["x"], until: "2026-10-26T16:00:00Z" }), null);
  assert.equal(attentionActive(null, -100, now), false);
});
