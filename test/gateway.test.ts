import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedAttempt, HANDLE_ATTEMPTS, knownPlaces, noteChat, readChats, route, targetChat, unsentPart } from "../internal/gateway.ts";
import { ackOutbox, isMuted, readMutes, readOutbox } from "../internal/mute.ts";
import { writeJson } from "../internal/fs.ts";
import { makePaths } from "../internal/paths.ts";

test("direct address is always high and always delivered", () => {
  assert.deepEqual(route({ isDm: true, isMention: false, isReply: false, listen: "mentions", muted: true, listening: false, allowed: true }), {
    deliver: true,
    high: true,
    reason: "dm",
  });
  assert.equal(
    route({ isDm: false, isMention: true, isReply: false, listen: "mentions", muted: true, listening: false, allowed: true }).high,
    true,
  );
  assert.equal(
    route({ isDm: false, isMention: false, isReply: true, listen: "mentions", muted: false, listening: false, allowed: true }).reason,
    "reply",
  );
});

test("ambient group chatter is low, and a mute only silences that", () => {
  assert.deepEqual(route({ isDm: false, isMention: false, isReply: false, listen: "all", muted: false, listening: false, allowed: true }), {
    deliver: true,
    high: false,
    reason: "ambient",
  });
  assert.equal(
    route({ isDm: false, isMention: false, isReply: false, listen: "all", muted: true, listening: false, allowed: true }).reason,
    "muted",
  );
});

test("a window it asked for turns plain talk into a knock", () => {
  assert.deepEqual(route({ isDm: false, isMention: false, isReply: false, listen: "mentions", muted: true, listening: true, allowed: true }), {
    deliver: true,
    high: true,
    reason: "listen",
  });
});

test("listen=mentions drops ambient entirely", () => {
  assert.equal(
    route({ isDm: false, isMention: false, isReply: false, listen: "mentions", muted: false, listening: false, allowed: true }).deliver,
    false,
  );
});

test("expired mutes stop counting, wildcard beats specific", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const file = join(dir, "mute.json");
  const now = Date.parse("2026-03-02T12:00:00Z");
  writeJson(file, {
    dm: { until: "2026-03-02T11:00:00Z", why: "过期了" },
    "*": { until: null, why: "全部都安静" },
  });
  const mutes = readMutes(file, now);
  assert.equal(mutes.dm, undefined);
  assert.deepEqual(isMuted(mutes, -1), { muted: true, key: "*" });
});

test("outbox items keep message order and are acked into sent/", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "001.json"), JSON.stringify({ id: "a", messages: ["一", "二"] }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ id: "b", messages: ["三"] }));

  const items = readOutbox(dir);
  assert.deepEqual(items.map((i) => i.messages), [["一", "二"], ["三"]]);

  ackOutbox(dir, items[0]!.file);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(readdirSync(join(dir, "sent")).length, 1);
});

test("a private chat beats a group as home, and only the first of each counts", () => {
  const chats: import("../internal/gateway.ts").Chats = { known: {} };
  noteChat(chats, { kind: "group", title: "群" }, -222, true);
  assert.equal(chats.home, -222, "第一个声音是群时，先当 home");
  noteChat(chats, { kind: "private", who: "telegram:@owner" }, 111, false);
  assert.equal(chats.home, 111, "私聊出现后应当接管");
  noteChat(chats, { kind: "group", title: "另一个群" }, -333, true);
  assert.equal(chats.home, 111);
  noteChat(chats, { kind: "private", who: "telegram:@other" }, 444, false);
  assert.equal(chats.home, 111, "第二个私聊不能抢");
});

test("home is learned once: a later group must not steal an unprompted word", () => {
  const chats: import("../internal/gateway.ts").Chats = { known: {} };
  noteChat(chats, { kind: "private", who: "telegram:@owner" }, 111, false);
  noteChat(chats, { kind: "group", title: "测试群" }, -222, true);
  assert.equal(chats.home, 111, "the group must not become home");
  assert.deepEqual(Object.keys(chats.known ?? {}).sort(), ["-222", "111"]);
});

test("an old chats.json that was a bare id still reads, and keeps that id as home", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const file = join(dir, "chats.json");
  writeFileSync(file, JSON.stringify({ alice: 111 }));
  const chats = readChats(file);
  assert.equal(chats.alice?.home, 111);
  assert.deepEqual(chats.alice?.known, {});
});

test("the page is told where it may speak, and which one is the default", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(join(root, "data", "_gateway"), { recursive: true });
  writeFileSync(
    join(root, "data", "_gateway", "chats.json"),
    JSON.stringify({
      alice: {
        home: 111,
        known: { "111": { kind: "private", who: "telegram:@owner" }, "-222": { kind: "group", title: "g" } },
      },
    }),
  );
  const places = knownPlaces(root, "alice");
  assert.deepEqual(places, [
    { id: 111, label: "私聊 telegram:@owner", home: true, kind: "private" },
    { id: -222, label: "群「g」", home: false, kind: "group" },
  ]);
});

test("a quote only applies inside the chat it came from", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.outbox, { recursive: true });
  writeJson(join(paths.outbox, "1-x.json"), {
    id: "1-x",
    messages: ["嗯"],
    chat: -1001234,
    replyTo: { chat: -1001234, messageId: 12 },
  });
  const items = readOutbox(paths.outbox);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]?.replyTo, { chat: -1001234, messageId: 12 });
  // an item written by an older/broken sender still reads as "no quote"
  writeJson(join(paths.outbox, "2-y.json"), { id: "2-y", messages: ["哈"], replyTo: "151" });
  assert.equal(readOutbox(paths.outbox)[1]?.replyTo, undefined);
});

test("a pure whitelist drops a stranger before anything is kept", () => {
  for (const shape of [
    { isDm: true, isMention: false, isReply: false },   // a DM is direct address
    { isDm: false, isMention: true, isReply: false },    // so is an @
    { isDm: false, isMention: false, isReply: true },     // and so is a reply
    { isDm: false, isMention: false, isReply: false },    // and plain group chatter
  ]) {
    assert.deepEqual(
      route({ ...shape, listen: "all", muted: false, listening: true, allowed: false }),
      { deliver: false, high: false, reason: "guest" },
      JSON.stringify(shape),
    );
  }
});

test("a message with nowhere to go is a dead end, not an endless retry", () => {
  // `deliver` used to answer "false" for this, and false means "not sent, try again in two
  // seconds" — forever, with no ops line and no failure count. A new instance whose bot has
  // nobody to talk to yet queued every `say` and reported 「说了 1 句」.
  assert.equal(targetChat(undefined, undefined, undefined), null, "no target, no pin, no home");
  // the pinned chat wins over the learned one: one is a decision, the other is an accident
  assert.equal(targetChat(undefined, 5, 7), 5);
  // and an explicit target wins over both, which is how a group is spoken into
  assert.equal(targetChat(-9, 5, 7), -9);
  // a bot that has neither: the chat it learned first is where an unprompted word goes
  assert.equal(targetChat(undefined, undefined, 7), 7);
});

test("a failed send is retried a few times, then let go of with one line", () => {
  const failures = new Map<string, number>();
  const verdicts = [1, 2, 3, 4, 5].map(() => failedAttempt(failures, "1-x.json"));
  assert.deepEqual(verdicts.map((v) => v.n), [1, 2, 3, 4, 5]);
  // four retries: a blip heals, a chat the bot was thrown out of does not keep the whole
  // outbox stuck (and, through the tripwire, mute the bot)
  assert.deepEqual(verdicts.map((v) => v.giveUp), [false, false, false, false, true]);
  // per item: one stuck message must not spend another one's attempts
  assert.equal(failedAttempt(failures, "2-y.json").n, 1);
  // and a success clears the count, so separate blips never add up
  failures.delete("1-x.json");
  assert.deepEqual(failedAttempt(failures, "1-x.json"), { n: 1, giveUp: false });
});

test("a failed handling gets its own bounded set of retries", () => {
  const failures = new Map<string, number>();
  const verdicts = Array.from({ length: HANDLE_ATTEMPTS }, () =>
    failedAttempt(failures, "update-17", HANDLE_ATTEMPTS),
  );
  assert.deepEqual(verdicts.map((v) => v.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(verdicts.map((v) => v.giveUp), [false, false, false, false, true]);
  // one update's failures must not spend another update's attempts
  assert.equal(failedAttempt(failures, "update-18", HANDLE_ATTEMPTS).n, 1);
  failures.delete("update-17");
  assert.equal(failedAttempt(failures, "update-17", HANDLE_ATTEMPTS).giveUp, false);
});

test("a send that broke halfway puts back only the words and files still owed", () => {
  // Two of three messages and one of two /work files went out before the attachment
  // failed. The sweep retries this same file: keeping the whole item says those words
  // five more times and trips the rate brake.
  const item = {
    chat: 111,
    messages: ["一", "二", "三"],
    files: ["/work/a.txt", "/work/b.txt"],
    attachments: [{ path: "/somewhere/F12-0-photo.jpg", name: "F12-0-photo.jpg", id: "F12" }],
    replyTo: { chat: 111, messageId: 2 },
  };
  const left = unsentPart(item, { texts: 2, files: 1, attachments: 0 });
  assert.deepEqual(left.messages, ["三"]);
  assert.deepEqual(left.files, ["/work/b.txt"]);
  assert.equal((left.attachments as unknown[]).length, 1);
  assert.equal(left.chat, 111, "where it was going survives the retry");
  assert.deepEqual(left.replyTo, item.replyTo, "so does the quote");

  // Nothing went out: a tripwire pause must leave the item exactly as it was.
  const untouched = unsentPart(item, { texts: 0, files: 0, attachments: 0 });
  assert.deepEqual(untouched.messages, item.messages);
  assert.deepEqual(untouched.files, item.files);

  // The sweep may now see an item with no words left but a file still owed.
  const onlyFiles = unsentPart(item, { texts: 3, files: 1, attachments: 1 });
  assert.deepEqual(onlyFiles.messages, []);
  assert.deepEqual(onlyFiles.files, ["/work/b.txt"]);
});
