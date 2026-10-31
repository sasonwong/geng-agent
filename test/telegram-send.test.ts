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
