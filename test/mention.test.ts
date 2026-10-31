import { test } from "node:test";
import assert from "node:assert/strict";
import { isMentioned } from "../internal/telegram.ts";
import type { BotIdentity, TgEntity, TgMessage } from "../internal/telegram.ts";

const me: BotIdentity = { id: 900, username: "our_bot" };
const other: BotIdentity = { id: 901, username: "other_bot" };

function msg(text: string, entities: TgEntity[] = []): TgMessage {
  return { message_id: 1, chat: { id: -1, type: "group" }, text, entities };
}

/** `mention` entity for the given token — the offset is real, the caller names the word. */
function entityOf(text: string, token: string, type: string, extra: Partial<TgEntity> = {}): TgEntity {
  const offset = text.indexOf(token);
  assert.notEqual(offset, -1, `${JSON.stringify(token)} not in ${JSON.stringify(text)}`);
  return { type, offset, length: token.length, ...extra };
}

test("a path in the middle of a sentence is not an address", () => {
  // the live shape that woke it: "broker wrote to /inbox, so …" — Telegram marks the
  // slash token as a bot_command; nobody was calling anybody
  const text = "只有 Telegram 往 /inbox 写文件那一下才敲门";
  assert.equal(isMentioned(msg(text, [entityOf(text, "/inbox", "bot_command")]), me), false);
});

test("a bare command at offset 0 is still not ours in a shared chat", () => {
  const text = "/probe 这条只有斜杠";
  assert.equal(isMentioned(msg(text, [entityOf(text, "/probe", "bot_command")]), me), false);
});

test("a command that names another bot is not ours", () => {
  const text = "/probe@other_bot 跑一下";
  assert.equal(isMentioned(msg(text, [entityOf(text, "/probe@other_bot", "bot_command")]), me), false);
});

test("a command that names us is ours", () => {
  const text = "/probe@our_bot 跑一下";
  assert.equal(isMentioned(msg(text, [entityOf(text, "/probe@our_bot", "bot_command")]), me), true);
});

test("a text_mention counts only when its user id is ours", () => {
  const text = "让 Alice 看一眼";
  const mine = entityOf(text, "Alice", "text_mention", { user: { id: me.id } });
  const theirs = entityOf(text, "Alice", "text_mention", { user: { id: other.id } });
  assert.equal(isMentioned(msg(text, [mine]), me), true);
  assert.equal(isMentioned(msg(text, [theirs]), me), false);
});

test("a text_mention without a user is not a broadcast", () => {
  const text = "让 Alice 看一眼";
  assert.equal(isMentioned(msg(text, [entityOf(text, "Alice", "text_mention")]), me), false);
});

test("@handle still works, entity or not", () => {
  const plain = "@our_bot 你在吗";
  assert.equal(isMentioned(msg(plain), me), true);
  assert.equal(isMentioned(msg(plain, [entityOf(plain, "@our_bot", "mention")]), me), true);
  assert.equal(isMentioned(msg("@other_bot 你在吗"), me), false);
});

test("a caption is read the same way as a text", () => {
  // a caption's entities arrive in `caption_entities`, not `entities`: the first version
  // of this test put them in `entities`, which is a shape Telegram never sends
  const caption = "图里是 /files 的文件";
  const message: TgMessage = {
    message_id: 2,
    chat: { id: -1, type: "group" },
    caption,
    caption_entities: [entityOf(caption, "/files", "bot_command")],
  };
  assert.equal(isMentioned(message, me), false);

  // and addressed the same way as a text, a caption does name us
  const mine = "/probe@our_bot 图里这个";
  assert.equal(
    isMentioned(
      { ...message, caption: mine, caption_entities: [entityOf(mine, "/probe@our_bot", "bot_command")] },
      me,
    ),
    true,
  );
});

test("a command for a longer name is a different bot", () => {
  // `/cmd@our_bot_2` is not ours: matching a prefix would knock us for another bot's command
  const text = "/probe@our_bot_2 跑一下";
  assert.equal(isMentioned(msg(text, [entityOf(text, "/probe@our_bot_2", "bot_command")]), me), false);
});

test("a bare handle written inside a longer name is not us", () => {
  assert.equal(isMentioned(msg("@our_bot_2 你在吗"), me), false);
  assert.equal(isMentioned(msg("mail: alice@our_bot.example"), me), false);
  // and the real one still counts, at the start, in the middle, with punctuation after
  assert.equal(isMentioned(msg("@our_bot, 你在吗"), me), true);
  assert.equal(isMentioned(msg("问一下 @our_bot 这条"), me), true);
});
