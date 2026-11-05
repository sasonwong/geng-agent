import { test } from "node:test";
import assert from "node:assert/strict";
import { sendFile, sendMessage, splitMessage } from "../internal/telegram.ts";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a sent file comes back with its id and the kind it went out as", async () => {
  const real = globalThis.fetch;
  let method = "";
  globalThis.fetch = (async (url: string) => {
    method = String(url).split("/").pop()!;
    return {
      text: async () => JSON.stringify({ ok: true, result: { message_id: 909 } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const png = join(tmpdir(), "one.png");
    const md = join(tmpdir(), "one.md");
    writeFileSync(png, "x");
    writeFileSync(md, "y");
    assert.deepEqual(await sendFile("t", -100, png), { id: 909, kind: "photo" });
    assert.equal(method, "sendPhoto");
    assert.deepEqual(await sendFile("t", -100, md), { id: 909, kind: "document" });
    assert.equal(method, "sendDocument");
  } finally {
    globalThis.fetch = real;
  }
});
