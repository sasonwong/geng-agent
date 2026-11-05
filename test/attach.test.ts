import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentOf, attachmentWords, hostPathForWorkPath, placeholderFor } from "../internal/attach.ts";

test("a photo uses its largest size, and a document keeps its own name", () => {
  const photo = attachmentOf({
    message_id: 1,
    chat: { id: 1, type: "private" },
    photo: [
      { file_id: "small", file_size: 100 },
      { file_id: "big", file_size: 900 },
    ],
  });
  assert.equal(photo?.fileId, "big");
  assert.equal(photo?.kind, "photo");

  const doc = attachmentOf({
    message_id: 2,
    chat: { id: 1, type: "private" },
    document: { file_id: "d", file_name: "报告.pdf", mime_type: "application/pdf", file_size: 5000 },
  });
  assert.equal(doc?.name, "报告.pdf");
  assert.equal(doc?.kind, "document");
  assert.equal(attachmentOf({ message_id: 3, chat: { id: 1, type: "private" }, text: "嗯" }), null);
});

test("voice is not fetched: there is nothing here that could make it words", () => {
  const voice = attachmentOf({
    message_id: 4,
    chat: { id: 1, type: "private" },
    voice: { file_id: "v", file_size: 1000 },
  });
  assert.equal(voice?.kind, "voice");
  // no file id means no download was ever attempted
  assert.equal(voice?.fileId, undefined);
  assert.equal(voice?.note, "没有转写");
});

test("only /work files can be sent out, and only if they exist", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "ok.html"), "hi");
  writeFileSync(join(root, "sub", "deep.txt"), "hi");
  assert.equal(hostPathForWorkPath(root, "/work/ok.html"), join(root, "ok.html"));
  assert.equal(hostPathForWorkPath(root, "/work/sub/deep.txt"), join(root, "sub", "deep.txt"));
  // nothing outside /work, nothing that climbs, nothing that does not exist
  assert.equal(hostPathForWorkPath(root, "/state/identity.md"), null);
  assert.equal(hostPathForWorkPath(root, "/work/../policy.json"), null);
  assert.equal(hostPathForWorkPath(root, "/work/missing.txt"), null);
});

// /work 是容器手里唯一可写的那块盘，所以它也是唯一能往里放链接的地方；而链接的 target 是
// 容器里的绝对路径，在宿主上却是另一个文件。`ln -s /etc/passwd /work/x` 之后 stat 跟着链接
// 走，`say(files: ["/work/x"])` 就把宿主的文件发出去了——书里那句「凭据不放它的书里」挡不住
// 这条。只有最终落在 workspace 里面的真路径才算它自己产出的文件。
test("a link inside /work is not a way to the rest of the host", (t) => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const outside = mkdtempSync(join(tmpdir(), "geng-outside-"));
  writeFileSync(join(root, "mine.txt"), "mine");
  writeFileSync(join(outside, "secret.txt"), "host secret");
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  } catch {
    t.skip("这台机器不让建符号链接");
    return;
  }
  assert.equal(hostPathForWorkPath(root, "/work/mine.txt"), join(root, "mine.txt"));
  assert.equal(hostPathForWorkPath(root, "/work/link.txt"), null, "链接指出去的不算它的文件");
});

test("an attachment is said in words, and an unknown kind does not become undefined", () => {
  assert.equal(attachmentWords({ kind: "document" }), "1个文件");
  assert.equal(attachmentWords({ kind: "photo" }), "1张图片");
  // the note is the only place "this cannot be listened to" lives
  assert.equal(attachmentWords({ kind: "voice", note: "没有转写" }), "1条语音（没有转写）");
  // a kind from a newer Telegram than this code must not print `1undefined`
  assert.equal(attachmentWords({ kind: "brand_new_kind" }), "1个文件");
});

test("the transcript placeholder names the thing, or says there was nothing", () => {
  assert.equal(placeholderFor([]), "[空消息]");
  assert.equal(placeholderFor([{ kind: "document" }]), "[1个文件]");
  assert.equal(placeholderFor([{ kind: "voice", note: "没有转写" }]), "[1条语音（没有转写）]");
});
