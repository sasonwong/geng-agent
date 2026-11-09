import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSummary } from "../image/extensions/lib/compact.ts";

function msg(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

test("a fold keeps the first user message and points at the raw session", () => {
  const branch = [
    msg("user", "本轮：把那封信回掉"),
    msg("assistant", [{ type: "text", text: "好" }]),
    msg("user", "插一句：别忘了"), // a steer must not replace the round's first message
  ];
  const s = compactSummary(branch, 24);
  assert.match(s, /本轮：把那封信回掉/);
  assert.doesNotMatch(s, /插一句/);
  assert.match(s, /24 条消息已折叠/);
  assert.match(s, /recall\(sources:\["sessions"\]\)/);
});

test("a long first message keeps both ends, because the reason it woke is the last line", () => {
  const head = "头".repeat(2_000);
  const tail = "本轮还剩约 5 分钟";
  const s = compactSummary([msg("user", head + tail)], 3);
  assert.match(s, /^本轮开始时的原话：\n头/);
  assert.match(s, new RegExp(tail));
  assert.match(s, new RegExp(`原 ${head.length + tail.length} 字`));
});

test("no first message is a pointer without an invented goal", () => {
  const s = compactSummary([], 2);
  assert.match(s, /早先的 2 条消息已折叠/);
  assert.doesNotMatch(s, /本轮开始时的原话/);

  // an image-only first message does not make the next user message the goal
  const image = compactSummary([msg("user", [{ type: "image", data: "x" }]), msg("user", "插一句")], 1);
  assert.doesNotMatch(image, /插一句/);
});
