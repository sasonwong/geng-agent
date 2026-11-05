import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { ensureDirs } from "../internal/fs.ts";
import { alreadyStored, storeAttachment } from "../internal/gateway.ts";
import type { Attachment } from "../internal/attach.ts";
import { fileById, listFiles } from "../internal/ids.ts";
import { openText } from "../internal/recall.ts";

/**
 * The two writers of `files/` are this path and the mail endpoint. Only the mail one used to
 * give its files an id, so a photo sent in Telegram was stored under a name no reader knows:
 * `recall(sources:["files"])` did not list it, `download("F1")` was "没有这个文件", and `/files`
 * is not mounted — the bytes existed and were reachable by nothing.
 */
test("what came with a telegram message lands where download and say can name it", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-att-"));
  const p = makePaths(root, "alice");
  ensureDirs(requiredDirs(p));
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    String(url).includes("/getFile")
      ? new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg" } }), { status: 200 })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
  try {
    const att: Attachment = { kind: "photo", fileId: "abc", name: "../../etc/passwd" };
    await storeAttachment(p, "alice", "1:fake", att, join(root, "data", "_ops"));

    assert.equal(att.id, "F1");
    assert.equal(att.note, undefined, "取到了就不该有 note");
    // the name that tried to climb out did not: it is a bare name inside files/
    assert.equal(fileById(p, "F1")?.name, "F1-0-passwd");
    assert.deepEqual(listFiles(p).map((f) => f.id), ["F1"]);
    // and the page's own instruction now resolves: `open(text)` prints download("/work/...")
    assert.match(openText(p, "F1", 0).text, /download\("F1", "\/work\/\.\.\."\)/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a redelivered message keeps the file the first delivery stored", () => {
  // Telegram redelivers when a round crashed between handling and recording the offset.
  // Re-fetching the media allocated a second id: the record moved to the new copy and the
  // first one stayed on disk — counted, listed, downloadable, and named by nothing.
  const kept = alreadyStored({
    attachments: [{ kind: "photo", id: "F1", name: "photo.jpg", bytes: 3 }],
  });
  assert.equal(kept?.id, "F1");
  // nothing stored yet, or a first attempt that failed (a note and no id) is retried
  assert.equal(alreadyStored(null), undefined);
  assert.equal(alreadyStored({ attachments: [{ kind: "photo", note: "没取到" }] }), undefined);
});

test("a download that fails says so, and leaves no id behind", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-att-"));
  const p = makePaths(root, "alice");
  ensureDirs(requiredDirs(p));
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const att: Attachment = { kind: "document", fileId: "abc", name: "report.pdf" };
    await storeAttachment(p, "alice", "1:fake", att, join(root, "data", "_ops"));
    assert.equal(att.id, undefined);
    assert.equal(att.note, "没取到");
    assert.equal(listFiles(p).length, 0, "盘上没有，列表里也不能有");
  } finally {
    globalThis.fetch = real;
  }
});
