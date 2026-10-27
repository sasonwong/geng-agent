import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentOf, attachmentWords, hostPathForWorkPath, placeholderFor, safeName } from "../internal/attach.ts";

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

test("a file name cannot climb out of the directory", () => {
  assert.equal(safeName(1, 2, "../../etc/passwd"), "1-2-passwd");
  assert.equal(safeName(-99, 7, "a b/c.txt"), "-99-7-c.txt");
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
