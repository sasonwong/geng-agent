import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSaid, readSaid, saidFile } from "../internal/people.ts";

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
