import { test } from "node:test";
import assert from "node:assert/strict";
import { gitIdentity } from "../internal/doctor.ts";

// The numbers are synthetic: 123456 is the app id, 123456789 the bot's user id. The
// comparison is only ever "is this the same number", so the values do not matter.
const APP = "123456";
const BOT = `123456789+example-app[bot]@users.noreply.github.com`;
const complete = (email = BOT) => ({
  GIT_AUTHOR_NAME: "alice",
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: "alice",
  GIT_COMMITTER_EMAIL: email,
});

test("no identity is a warn, not a failure: the clone's own config still applies", () => {
  const r = gitIdentity({}, APP);
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
});

test("half a pair fails: the missing half falls back to whatever the clone or HOME says", () => {
  const r = gitIdentity({ GIT_AUTHOR_NAME: "alice", GIT_AUTHOR_EMAIL: BOT }, APP);
  assert.equal(r.ok, false);
  assert.equal(r.missing, false);
  assert.match(r.detail, /GIT_COMMITTER_NAME/);
});

test("the app id in the address fails — the one mistake nothing else reports", () => {
  const r = gitIdentity(complete(`123456+example-app[bot]@users.noreply.github.com`), APP);
  assert.equal(r.ok, false);
  assert.equal(r.missing, false);
  assert.match(r.detail, /App ID/);
});

test("the bot's user id passes, with or without an app to compare against", () => {
  assert.deepEqual(gitIdentity(complete(), APP), { ok: true, missing: false, detail: `alice <${BOT}>` });
  assert.equal(gitIdentity(complete(), "").ok, true);
});
