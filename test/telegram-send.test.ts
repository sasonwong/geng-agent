import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMessage, splitMessage } from "../internal/telegram.ts";

/** Answers the next sendMessage call with the id it is given, in call order. */
function answerWith(ids: number[]): () => void {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    const id = ids[n++];
    return {
      text: async () => JSON.stringify({ ok: true, result: { message_id: id } }),
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("a sent line comes back with the id Telegram gave it", async () => {
  const restore = answerWith([41]);
  try {
    assert.deepEqual(await sendMessage("t", -100, "你好"), [41]);
  } finally {
    restore();
  }
});

test("a text split into several messages reports every id, in order", async () => {
  const long = "x".repeat(4000) + "\n" + "y".repeat(4000) + "\n" + "z".repeat(4000);
  const parts = splitMessage(long);
  assert.ok(parts.length > 1, "this text is meant to split");
  const expected = parts.map((_, i) => 100 + i);
  const restore = answerWith(expected);
  try {
    assert.deepEqual(await sendMessage("t", -100, long), expected);
  } finally {
    restore();
  }
});

test("a split never cuts a character in half", () => {
  // an emoji is two UTF-16 units; a part ending between them is a broken character that
  // Telegram would refuse or mangle. The boundary lands on the pair on purpose.
  const text = "a".repeat(3999) + "😀" + "b".repeat(10);
  const parts = splitMessage(text);
  assert.ok(parts.length > 1, "this text is meant to split");
  assert.equal(parts.join(""), text, "切完拼回去还是原文");
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < part.length ? part.charCodeAt(i + 1) : 0;
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `位置 ${i} 上是半个字符`);
      }
    }
  }
});
