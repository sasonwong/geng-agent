import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboxId, quoteFor } from "../internal/quote.ts";

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
