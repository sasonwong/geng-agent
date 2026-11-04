import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolsDigest } from "../internal/doctor.ts";

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "geng-digest-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

test("同名同内容的两个目录，摘要相同", () => {
  const a = dir({ "mail.ts": "export const a = 1;\n", "websearch.ts": "export const b = 2;\n" });
  const b = dir({ "mail.ts": "export const a = 1;\n", "websearch.ts": "export const b = 2;\n" });
  assert.equal(toolsDigest(a), toolsDigest(b));
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("个数相同、内容不同 —— 这条就是这个检查存在的理由", () => {
  const a = dir({ "mail.ts": "export const a = 1;\n", "websearch.ts": "export const b = 2;\n" });
  const b = dir({ "mail.ts": "export const a = 1;\n", "websearch.ts": "export const b = 3;\n" });
  assert.notEqual(toolsDigest(a), toolsDigest(b));
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("少一个文件 —— 挂载缺了一块时要响", () => {
  const a = dir({ "mail.ts": "a", "websearch.ts": "b", "say-mute.ts": "c" });
  const b = dir({ "mail.ts": "a", "websearch.ts": "b" });
  assert.notEqual(toolsDigest(a), toolsDigest(b));
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("改了文件名 —— 内容一样也不算同一份", () => {
  const a = dir({ "mail.ts": "a" });
  const b = dir({ "mail-tool.ts": "a" });
  assert.notEqual(toolsDigest(a), toolsDigest(b));
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("空目录和目录不存在，摘要都是空串，不冒充任何一个真实摘要", () => {
  const empty = dir({});
  const gone = join(tmpdir(), "geng-digest-definitely-missing");
  assert.equal(toolsDigest(empty), "");
  assert.equal(toolsDigest(gone), "");
  rmSync(empty, { recursive: true, force: true });
});

test("真实的 image/extensions 有一个摘要，不是空串", () => {
  const here = new URL(".", import.meta.url).pathname;
  const digest = toolsDigest(join(here, "..", "image", "extensions"));
  assert.match(digest, /^[0-9a-f]{40}$/);
});
