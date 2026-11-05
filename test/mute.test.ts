import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackOutbox, isMuted, keyCanMute, readOutbox, trimOutbox } from "../internal/mute.ts";
import { route } from "../internal/gateway.ts";

test("only a key that route() actually reads can mute", () => {
  assert.equal(keyCanMute("*"), true);
  assert.equal(keyCanMute("chat:-1001234567890"), true);
  assert.equal(keyCanMute("chat:-1234"), true);
  // `dm` is the one that looked like state and was not: route() returns high before muted
  assert.equal(keyCanMute("dm"), false);
  assert.equal(keyCanMute("chat:abc"), false);
  assert.equal(keyCanMute("telegram:@someone"), false);
});

test("a dm key is not a silence, because route() never asks about one", () => {
  // it was read by isMuted and then thrown away by route: a key that looks like state and
  // does nothing. The map is asked about ambient only, so a hand-written `dm` changes
  // nothing — and the tool refuses to write one in the first place.
  assert.deepEqual(isMuted({ dm: { until: null, why: "看起来像静音" } }, -1), { muted: false, key: null });
  assert.deepEqual(isMuted({ "chat:-1": { until: null } }, -1), { muted: true, key: "chat:-1" });
});

test("a dm is high no matter what the mute map says", () => {
  for (const muted of [true, false]) {
    assert.deepEqual(route({ isDm: true, isMention: false, isReply: false, listen: "all", muted, listening: false, allowed: true }), {
      deliver: true,
      high: true,
      reason: "dm",
    });
  }
  // and the one case a mute does reach: ambient group talk
  assert.equal(
    route({ isDm: false, isMention: false, isReply: false, listen: "all", muted: true, listening: false, allowed: true }).reason,
    "muted",
  );
});

test("a partially sent item keeps only the unsaid parts in the queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "001.json");
  writeFileSync(file, JSON.stringify({ id: "a", messages: ["一", "二", "三"], chat: -100 }));

  trimOutbox(file, 0);
  assert.deepEqual(readOutbox(dir)[0]?.messages, ["一", "二", "三"], "零个不算，什么都别动");
  // two parts went out: the retry must say only 三, not 一 and 二 again
  trimOutbox(file, 2);
  assert.deepEqual(readOutbox(dir)[0]?.messages, ["三"]);
  // the rest of the item is untouched
  assert.equal(readOutbox(dir)[0]?.chat, -100);
  // nothing left to say is a normal outcome: the files may still be pending
  trimOutbox(file, 1);
  assert.deepEqual(readOutbox(dir)[0]?.messages, []);
});

test("acking a queue item is not a string split on one separator", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "001.json"), JSON.stringify({ id: "a", messages: ["一"] }));

  const items = readOutbox(dir);
  ackOutbox(dir, items[0]!.file);
  // the item moved, and the sent copy kept the bare name: a hand-rolled split on "/"
  // does that only on POSIX, and the file silently stays in the queue elsewhere
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(readdirSync(join(dir, "sent")).includes("001.json"), true);
});
