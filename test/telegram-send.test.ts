import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEND_LIMIT, sendFile, sendMessage, splitMessage } from "../internal/telegram.ts";

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

// 上限不是 Telegram 的礼貌，是这一侧的：`sendFile` 把整个文件读进内存再往上送，所以一个
// 谁都能往 /work 里放的大文件先变成 RSS，再变成 API 那句拒绝。超了就直接拒，读都不读。
test("a file past the upload cap is refused before it is read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const big = join(dir, "big.bin");
  writeFileSync(big, "");
  truncateSync(big, SEND_LIMIT + 1); // 稀疏文件：大小是真的，空间不是
  await assert.rejects(sendFile("token", 1, big), /超过发送上限/);
  // 上限之内照旧往下走：把 fetch 换掉，免得这条测试真去连一次 Telegram
  const small = join(dir, "small.bin");
  writeFileSync(small, "hi");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network");
  }) as typeof fetch;
  try {
    await assert.rejects(sendFile("token", 1, small), (err: Error) => !/超过发送上限/.test(err.message));
  } finally {
    globalThis.fetch = real;
  }
});
