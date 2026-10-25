import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekInbox, takeInbox } from "../internal/inbox.ts";

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

test("takeInbox drains in filename order", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "第二条" }));
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "第一条" }));

  const taken = takeInbox(dir, seen);
  assert.deepEqual(taken.map((m) => m.text), ["第一条", "第二条"]);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(readdirSync(seen).length, 2);
});

test("takeInbox quarantines an unparseable message instead of dying", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), "{not json");
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "好的" }));

  const taken = takeInbox(dir, seen);
  assert.deepEqual(taken.map((m) => m.text), ["好的"]);
  assert.ok(readdirSync(seen).some((f) => f.endsWith(".bad")));
});

test("takeInbox drops an empty-text message", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "   " }));
  assert.equal(takeInbox(dir, seen).length, 0);
});
