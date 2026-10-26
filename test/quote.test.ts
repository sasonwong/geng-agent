import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxId, quoteFor, quotedOf } from "../internal/quote.ts";
import { appendSaid, readSaid } from "../internal/people.ts";
import { nameOf } from "../internal/telegram.ts";

test("an inbox id carries the chat it belongs to, negative chats included", () => {
  assert.deepEqual(parseInboxId("-1001234567890-151"), { chat: -1001234567890, messageId: 151 });
  assert.deepEqual(parseInboxId("123456789-7"), { chat: 123456789, messageId: 7 });
});

test("anything that is not a message is not a quote", () => {
  for (const bad of ["", "151", "-151", "abc-def", "123456789-", "-0-5", "1-0"]) {
    assert.equal(parseInboxId(bad), null, bad);
  }
});

test("a quote is dropped, not resent elsewhere, when the chat does not match", () => {
  assert.equal(quoteFor(-100, { chat: -100, messageId: 5 }), 5);
  assert.equal(quoteFor(-100, { chat: -200, messageId: 5 }), undefined);
  assert.equal(quoteFor(-100, undefined), undefined);
});

test("the quoted message comes through with its words, not just its id", () => {
  const chat = -1001234567890;
  const q = quotedOf(
    chat,
    { message_id: 8, from: { username: "someone_else" }, text: "  原文在这\n你说过 " },
    nameOf,
  );
  assert.deepEqual(q, { id: "-1001234567890-8", from: "telegram:@someone_else", text: "原文在这 你说过" });
  // a photo carries its words in the caption
  assert.equal(quotedOf(chat, { message_id: 9, caption: "图" }, nameOf)?.text, "图");
  // nothing to point at → no quote at all
  assert.equal(quotedOf(chat, undefined, nameOf), null);
  assert.equal(quotedOf(chat, { text: "无 id" }, nameOf), null);
  // a long quoted message is cut, because it rides on every page it appears on
  assert.equal(quotedOf(chat, { message_id: 1, text: "字".repeat(500) }, nameOf)?.text?.length, 201);
});

test("a transcript line keeps the quote it was written with", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const quote = { id: "-100-8", from: "telegram:@you", text: "上一句" };
  appendSaid(root, -100, { at: "2026-03-02T09:00:00Z", dir: "in", text: "这句", id: "-100-9", quote });
  const t = readSaid(root, -100, 5);
  assert.deepEqual(t?.tail[0]?.quote, quote);
  assert.equal(t?.tail[0]?.id, "-100-9");
});
