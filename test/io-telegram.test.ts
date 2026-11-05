import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_LIMIT, SEND_LIMIT, sendFile, splitMessage } from "../internal/telegram.ts";
import { excerpt } from "../internal/fs.ts";

/** 稀疏文件：只把长度撑到 size，不真的在盘上铺 50 MB 的零。 */
function sparseFile(size: number): { path: string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "geng-io-tg-"));
  const path = join(dir, "big.bin");
  const fd = openSync(path, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  return { path, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("SEND_LIMIT 是 Bot API 的 50 MB 上传上限，FILE_LIMIT 仍是下载的 20 MB", () => {
  assert.equal(SEND_LIMIT, 50 * 1024 * 1024);
  assert.equal(FILE_LIMIT, 20 * 1024 * 1024);
});

test("sendFile 在读取超过 50 MB 的文件之前就拒绝", async () => {
  // 旧行为：先 readFileSync(path) 把整份文件读进内存，一个 GB 就是网关一个 GB 的 RSS。
  // 把 fetch 顶掉，超限时应连 fetch 都不该走到，更不该去读那几千万字节。
  const big = sparseFile(SEND_LIMIT + 1);
  const real = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("fetch 不该被调用");
  }) as typeof fetch;
  try {
    await assert.rejects(() => sendFile("t", -100, big.path), /超过/);
    assert.equal(called, false, "超限时不该走到 fetch");
  } finally {
    globalThis.fetch = real;
    big.clean();
  }
});

test("sendFile 的小文件照常走到 fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-io-tg-small-"));
  const path = join(dir, "a.txt");
  writeFileSync(path, "hi");
  const real = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return { text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
  }) as typeof fetch;
  try {
    await sendFile("t", -100, path);
    assert.equal(called, true, "不超限的文件要照常发送");
  } finally {
    globalThis.fetch = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一段里只要出现孤立的高位或低位代理就说明字被拆坏了。 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("splitMessage 不会把代理对拆成两半", () => {
  const emoji = "😀"; // U+1F600
  const ext = "𠀋"; // U+2000B，CJK 扩展 B
  const cases: { limit: number; text: string }[] = [];
  for (const limit of [4, 10, 4000]) {
    // 高位正好停在第 limit 个字符（下标 limit-1）：旧代码会把它切成一段的最后一个字。
    cases.push({ limit, text: "x".repeat(limit - 1) + emoji + "y".repeat(limit + 3) });
    cases.push({ limit, text: "a".repeat(limit - 1) + ext + "b".repeat(limit + 3) });
  }
  cases.push({ limit: 1, text: emoji + "abc" }); // width=1 的退化情形
  cases.push({ limit: 5, text: `甲${emoji}乙${ext}丙`.repeat(20) });

  for (const { limit, text } of cases) {
    const parts = splitMessage(text, limit);
    assert.ok(parts.length >= 1);
    assert.equal(parts.join(""), text, "切分不能吞字");
    for (const part of parts) {
      assert.equal(hasLoneSurrogate(part), false, `limit=${limit} 把代理对拆开了：${JSON.stringify(part)}`);
    }
  }
});

test("excerpt 的截断标记不换行，单行包裹不被撑破", () => {
  // 旧行为在标记前加了 \n，五个把字段包进 （…） / 「…」 的调用方都会被撑成两行。
  const t = excerpt("abcdefghij", 4);
  assert.equal(t, "abcd…(截断)");
  assert.equal(t.includes("\n"), false, "标记里不能有换行");
  assert.equal(`（${t}）`.includes("\n"), false, "塞进单行括号里仍然是一行");
  // 没截断时保持原来的 trim 语义
  assert.equal(excerpt("  hi  ", 10), "hi");
  assert.equal(excerpt(null, 10), "");
});
