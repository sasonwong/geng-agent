import { test } from "node:test";
import assert from "node:assert/strict";
import { isMuted, keyCanMute } from "../internal/mute.ts";
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
