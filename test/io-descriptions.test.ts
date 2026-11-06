import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("forget 的描述说清 {files} 是累计的待删清单", () => {
  const src = readFileSync(join(REPO, "image", "extensions", "say-mute.ts"), "utf8");
  const line = src.split("\n").find((l) => l.includes("返回 {files}"));
  assert.ok(line, "forget 的描述里得说明返回的是什么");

  // 旧写法把它说成「删掉之后还剩的待删清单」，正好说反：宿主 /files/forget 返回的是
  // 历次累计、还没删的队列（book.ts 里 [...had, ...names]），删除由 daemon 在下一轮
  // 醒来之前统一执行（daemon.ts 的 forgetFiles + rmSync(filesForget)），不是当场删。
  assert.match(line, /累计的待删清单/);
  assert.doesNotMatch(line, /删掉之后还剩的待删清单/);
  assert.match(line, /下一轮醒来之前/);
});
