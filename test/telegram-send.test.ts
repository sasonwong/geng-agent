import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LIMIT, downloadFile, sendMessage, splitMessage } from "../internal/telegram.ts";

const destFor = (): string => join(mkdtempSync(join(tmpdir(), "geng-dl-")), "file.bin");

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

test("a download that declares too much is refused before its body is read", async () => {
  const dest = destFor();
  const real = globalThis.fetch;
  let bodyTouched = false;
  globalThis.fetch = (async () => ({
    ok: true,
    headers: new Headers({ "content-length": String(FILE_LIMIT + 1) }),
    get body() {
      bodyTouched = true;
      return null;
    },
  }) as unknown as Response) as typeof fetch;
  try {
    // arrayBuffer() used to be the first thing called, so a huge response filled
    // the gateway's memory before the 20 MB check ever ran.
    await assert.rejects(downloadFile("t", "path", dest), /超过/);
    assert.equal(bodyTouched, false, "声明超限时不该碰响应体");
    assert.equal(existsSync(dest), false, "也不该留下文件");
  } finally {
    globalThis.fetch = real;
  }
});

test("an undeclared download stops as soon as it passes the cap", async () => {
  const dest = destFor();
  const real = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024);
  let served = 0;
  let buffered = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (served >= 100) {
        controller.close();
        return;
      }
      served += 1;
      controller.enqueue(chunk);
    },
  });
  globalThis.fetch = (async () => ({
    ok: true,
    headers: new Headers(),
    body,
    arrayBuffer: async () => {
      buffered = true;
      return new ArrayBuffer(FILE_LIMIT + 1);
    },
  }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(downloadFile("t", "path", dest), /超过/);
    assert.equal(buffered, false, "不能先把整个响应读进内存再检查大小");
    // The stream may prefetch one chunk past the cap; what matters is that it did
    // not read the whole 100 MB body before deciding.
    assert.ok(served <= 25, `超过上限就该停，实际读了 ${served} MB`);
    assert.equal(existsSync(dest), false, "拒绝时不能留下半文件");
  } finally {
    globalThis.fetch = real;
  }
});

test("a good download lands as one complete file", async () => {
  const dest = destFor();
  const real = globalThis.fetch;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  globalThis.fetch = (async () => ({
    ok: true,
    headers: new Headers(),
    body,
    // present so this positive control also passes against the old arrayBuffer()
    // implementation — its job is to prove a good file lands, not to catch the rewrite
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(await downloadFile("t", "path", dest), 3);
    assert.deepEqual([...readFileSync(dest)], [1, 2, 3]);
    assert.equal(existsSync(`${dest}.tmp-${process.pid}`), false, "tmp 要被 rename 掉");
  } finally {
    globalThis.fetch = real;
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
