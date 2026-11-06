import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxId, parseReplyTo, quoteFor, quotedOf } from "../internal/quote.ts";
import { appendSaid, readSaid, saidHasId } from "../internal/people.ts";
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

test("the object spelling of a quote obeys the same rules as the id", () => {
  // The id branch has always refused NaN, fractions, 0 and negatives. The object
  // branch only checked `typeof === "number"`, so an outbox item written by an
  // older tool could carry NaN all the way into reply_to_message_id and get a 400.
  for (const bad of [
    { chat: Number.NaN, messageId: 1 },
    { chat: 1.5, messageId: 1 },
    { chat: 0, messageId: 1 },
    { chat: -1001, messageId: 0 },
    { chat: -1001, messageId: -5 },
    { chat: Number.POSITIVE_INFINITY, messageId: 1 },
    { chat: -1001, messageId: 1.5 },
  ]) {
    assert.equal(parseReplyTo(bad), null, `两种写法要同一套规则：${bad.chat}/${bad.messageId}`);
  }
  assert.deepEqual(parseReplyTo({ chat: -1001, messageId: 151 }), { chat: -1001, messageId: 151 });
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

test("a quote is read by one parser, whether it arrives as an id or as an object", () => {
  // the tool writes the id a listing printed; the outbox stores `{chat, messageId}`
  for (const id of ["M-1001-151", "-1001-151", "#-1001-151", " M-1001-151 "]) {
    assert.deepEqual(parseReplyTo(id), { chat: -1001, messageId: 151 }, id);
  }
  assert.deepEqual(parseReplyTo({ chat: -1001, messageId: 151 }), { chat: -1001, messageId: 151 });
  // absent and unreadable are different answers: the caller refuses one and ignores the other
  assert.equal(parseReplyTo(undefined), undefined);
  assert.equal(parseReplyTo(null), undefined);
  for (const junk of ["151", "abc", 42, { chat: "-1001" }]) {
    assert.equal(parseReplyTo(junk), null, JSON.stringify(junk));
  }
});

test("对象写法与 id 写法共用同一套校验，一个也不多认", () => {
  // 两种写法最终都过 quoteOf：Number.isSafeInteger + chat !== 0 + messageId > 0。
  // 任何一边多认一个，reply_to_message_id 就会带着非法值走到 Telegram 拿 400。
  for (const [chat, messageId] of [
    [-1001, 151],
    [-1001, Number.NaN],
    [-1001, 0],
    [-1001, -5],
    [-1001, 1.5],
    [0, 151],
    [1.5, 151],
    [Number.POSITIVE_INFINITY, 151],
    [Number.MAX_SAFE_INTEGER + 1, 151],
  ] as const) {
    const asId = parseInboxId(`${chat}-${messageId}`);
    const asObject = parseReplyTo({ chat, messageId });
    assert.deepEqual(asObject, asId, `两种写法对 ${chat}-${messageId} 要同一结论`);
  }
});

test("saidHasId 认得出已经记过的行，供重投去重", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const chat = -100;
  assert.equal(saidHasId(root, chat, "-100-151"), false, "没有这个 chat 的 transcript");
  appendSaid(root, chat, { at: "2026-03-02T09:00:00Z", dir: "in", text: "这句", id: "-100-151" });
  assert.equal(saidHasId(root, chat, "-100-151"), true);
  assert.equal(saidHasId(root, chat, "-100-999"), false, "同一 chat 里没有的 id");
  assert.equal(saidHasId(root, -999, "-100-151"), false, "别的人说过的不算");
});
