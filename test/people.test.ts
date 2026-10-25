import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeSince, appendSaid, lastSaidIn, readSaid, saidFile } from "../internal/people.ts";

function data(): string {
  return mkdtempSync(join(tmpdir(), "geng-test-"));
}

test("a transcript keeps both directions in order", () => {
  const d = data();
  appendSaid(d, 42, { at: "2026-03-02T09:00:00Z", dir: "in", text: "在吗", from: "telegram:@you" });
  appendSaid(d, 42, { at: "2026-03-02T09:00:30Z", dir: "out", text: "在" });
  const t = readSaid(d, 42, 10);
  assert.equal(t?.total, 2);
  assert.deepEqual(t?.tail.map((l) => l.text), ["在吗", "在"]);
  assert.equal(t?.tail[0]?.from, "telegram:@you");
});

test("the tail is the newest few, and the count is everything", () => {
  const d = data();
  for (let n = 0; n < 50; n++) appendSaid(d, 7, { at: "2026-03-02T09:00:00Z", dir: "in", text: `第 ${n} 句` });
  const t = readSaid(d, 7, 3);
  assert.equal(t?.total, 50);
  assert.deepEqual(t?.tail.map((l) => l.text), ["第 47 句", "第 48 句", "第 49 句"]);
  assert.ok((t?.bytes ?? 0) > 0);
});

test("one broken line does not hide the conversation, and no file is not an error", () => {
  const d = data();
  appendSaid(d, 9, { at: "2026-03-02T09:00:00Z", dir: "in", text: "第一句" });
  appendFileSync(saidFile(d, 9), "{not json\n");
  appendSaid(d, 9, { at: "2026-03-02T09:01:00Z", dir: "in", text: "第三句" });
  assert.deepEqual(readSaid(d, 9, 10)?.tail.map((l) => l.text), ["第一句", "第三句"]);
  assert.equal(readSaid(d, 1234, 10), null);
});

test("the freshest exchange wins, and a message it started counts the same", () => {
  const d = data();
  appendSaid(d, 1, { at: "2026-03-02T09:00:00Z", dir: "in", text: "早", from: "telegram:@a" });
  appendSaid(d, 1, { at: "2026-03-02T09:00:10Z", dir: "out", text: "早" });
  // it reached out to someone else by itself, later
  appendSaid(d, 2, { at: "2026-03-02T10:00:00Z", dir: "in", text: "在吗", from: "telegram:@b" });
  appendSaid(d, 2, { at: "2026-03-02T10:00:20Z", dir: "out", text: "在" });

  const t = lastSaidIn(d);
  assert.equal(t?.chat, 2);
  assert.equal(t?.who, "telegram:@b");
  assert.equal(t?.tail.at(-1)?.text, "在");
  assert.equal(lastSaidIn(mkdtempSync(join(tmpdir(), "geng-test-"))), null);
});

test("without a reply yet, the name still comes from their line", () => {
  const d = data();
  appendSaid(d, 5, { at: "2026-03-02T09:00:00Z", dir: "in", text: "喂", from: "telegram:@c" });
  assert.equal(lastSaidIn(d)?.who, "telegram:@c");
});

test("everyone it talked to in the window is listed, not just the last one", () => {
  const d = data();
  appendSaid(d, 1, { at: "2026-03-02T09:00:00Z", dir: "in", text: "早", from: "telegram:@a" });
  appendSaid(d, 2, { at: "2026-03-02T09:01:00Z", dir: "in", text: "在吗", from: "telegram:@b" });
  appendSaid(d, 3, { at: "2026-03-02T08:00:00Z", dir: "in", text: "旧的", from: "telegram:@c" });
  const who = activeSince(d, Date.parse("2026-03-02T08:30:00Z")).map((a) => a.who).sort();
  assert.deepEqual(who, ["telegram:@a", "telegram:@b"]);
});
