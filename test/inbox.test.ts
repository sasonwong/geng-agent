import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markSeen, newestKnock, peekInbox } from "../internal/inbox.ts";

function inbox(): { dir: string; seen: string } {
  const base = mkdtempSync(join(tmpdir(), "geng-test-"));
  const dir = join(base, "inbox");
  const seen = join(dir, "seen");
  mkdirSync(seen, { recursive: true });
  return { dir, seen };
}

test("peekInbox does not consume anything", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "在吗" }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "还在吗" }));

  const peeked = peekInbox(dir);
  assert.equal(peeked.length, 2);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);
  assert.equal(readdirSync(seen).length, 0);
});

test("peekInbox reads in filename order and leaves the files alone", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "第二条" }));
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "第一条" }));

  const peeked = peekInbox(dir);
  assert.deepEqual(peeked.map((m) => m.text), ["第一条", "第二条"]);
  assert.deepEqual(peeked.map((m) => m.file), ["001.json", "002.json"]);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);
  assert.equal(readdirSync(seen).length, 0);
});

test("markSeen moves only what this wake handed over", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "第一条" }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "第二轮才看" }));

  markSeen([dir], seen, ["001.json"]);
  assert.deepEqual(readdirSync(seen), ["001.json"]);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")), ["002.json"]);
});

test("markSeen quarantines an unparseable message instead of dying", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), "{not json");
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "好的" }));

  markSeen([dir], seen, ["001.json", "002.json"]);
  assert.ok(readdirSync(seen).some((f) => f.endsWith(".bad")));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")), []);
});

test("an empty-text message is not handed over, and stays where it is", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "   " }));
  assert.equal(peekInbox(dir).length, 0);
  markSeen([dir], seen, ["001.json"]);
  assert.ok(readdirSync(seen).some((f) => f.endsWith(".bad")));
});

test("the typing indicator follows the newest knock, in its own chat", () => {
  const msgs = [
    { id: "1", at: "2026-03-02T08:00:00Z", chat: 111 },
    { id: "2", at: "2026-03-02T08:05:00Z", chat: -222 },
    { id: "3", at: "2026-03-02T08:01:00Z" },
  ];
  assert.equal(newestKnock(msgs)?.id, "2");
  assert.equal(newestKnock([{ id: "4", at: "2026-03-02T08:00:00Z" }]), null);
});
