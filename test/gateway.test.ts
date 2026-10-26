import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownPlaces, noteChat, readChats, route } from "../internal/gateway.ts";
import { ackOutbox, isMuted, readMutes, readOutbox } from "../internal/mute.ts";
import { writeJson } from "../internal/state.ts";

test("direct address is always high and always delivered", () => {
  assert.deepEqual(route({ isDm: true, isMention: false, isReply: false, listen: "mentions", muted: true }), {
    deliver: true,
    high: true,
    reason: "dm",
  });
  assert.equal(
    route({ isDm: false, isMention: true, isReply: false, listen: "mentions", muted: true }).high,
    true,
  );
  assert.equal(
    route({ isDm: false, isMention: false, isReply: true, listen: "mentions", muted: false }).reason,
    "reply",
  );
});

test("ambient group chatter is low, and a mute only silences that", () => {
  assert.deepEqual(route({ isDm: false, isMention: false, isReply: false, listen: "all", muted: false }), {
    deliver: true,
    high: false,
    reason: "ambient",
  });
  assert.equal(
    route({ isDm: false, isMention: false, isReply: false, listen: "all", muted: true }).reason,
    "muted",
  );
});

test("listen=mentions drops ambient entirely", () => {
  assert.equal(
    route({ isDm: false, isMention: false, isReply: false, listen: "mentions", muted: false }).deliver,
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
  assert.deepEqual(isMuted(mutes, { chatId: -1, isDm: true }), { muted: true, key: "*" });
});

test("outbox items keep message order and are acked into sent/", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "001.json"), JSON.stringify({ id: "a", messages: ["一", "二"] }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ id: "b", text: "三" }));

  const items = readOutbox(dir);
  assert.deepEqual(items.map((i) => i.messages), [["一", "二"], ["三"]]);

  ackOutbox(dir, items[0]!.file);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1);
  assert.equal(readdirSync(join(dir, "sent")).length, 1);
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
    { id: 111, label: "私聊 telegram:@owner", home: true },
    { id: -222, label: "群「g」", home: false },
  ]);
});
