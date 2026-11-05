import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendFile, sendMessage, splitMessage } from "../internal/telegram.ts";

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

test("a file too big for a bot upload is refused before it is read into memory", async () => {
  // Telegram's own limit for a bot upload is 50 MB. Reading the file first and letting the
  // API refuse it costs the gateway the whole file in RAM — a /work file is something the
  // agent made, so its size is not ours to assume.
  const dir = mkdtempSync(join(tmpdir(), "geng-send-"));
  const file = join(dir, "big.bin");
  writeFileSync(file, "x".repeat(9));
  let uploads = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    uploads += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => sendFile("t", -100, file, 8), /超过/);
    assert.equal(uploads, 0, "超限的文件不该读进来，更不该发出去");
    // exactly at the limit is still a send
    await sendFile("t", -100, file, 9);
    assert.equal(uploads, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("a file says what it was sent as, and the id the chat got", async () => {
  // The transcript's row for an outgoing file depends on these two: the kind picks the
  // placeholder word, the id lets a later line point at the message the file became.
  const dir = mkdtempSync(join(tmpdir(), "geng-sent-"));
  const doc = join(dir, "note.txt");
  const img = join(dir, "shot.png");
  writeFileSync(doc, "x");
  writeFileSync(img, "x");
  const real = globalThis.fetch;
  let method = "";
  globalThis.fetch = (async (url: string) => {
    method = String(url).slice(String(url).lastIndexOf("/") + 1);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await sendFile("t", -100, doc), { kind: "document", id: 77 });
    assert.equal(method, "sendDocument");
    assert.deepEqual(await sendFile("t", -100, img), { kind: "photo", id: 77 });
    assert.equal(method, "sendPhoto");
  } finally {
    globalThis.fetch = real;
  }
});
