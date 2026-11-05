import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSplitter, RepeatWatcher, type ToolCall } from "../internal/rpc.ts";

function collect(): { records: Record<string, unknown>[]; feed: (s: string) => void } {
  const records: Record<string, unknown>[] = [];
  const feed = makeSplitter((r) => records.push(r));
  return { records, feed };
}

test("splitter handles records split across chunks", () => {
  const { records, feed } = collect();
  feed('{"type":"a"}\n{"type":"b"}');
  feed('\n{"ty');
  feed('pe":"c"}\n');
  assert.deepEqual(records.map((r) => r.type), ["a", "b", "c"]);
});

test("splitter does not split on U+2028 — that is legal inside JSON", () => {
  const { records, feed } = collect();
  feed('{"text":"a\u2028b\u2029c"}\n');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.text, "a\u2028b\u2029c");
});

test("splitter tolerates CRLF and drops malformed lines", () => {
  const { records, feed } = collect();
  feed('{"type":"a"}\r\n{broken\r\n\r\n{"type":"b"}\r\n');
  assert.deepEqual(records.map((r) => r.type), ["a", "b"]);
});

test("RepeatWatcher reports the threshold crossing once per level", () => {
  const w = new RepeatWatcher(3);
  const call: ToolCall = { name: "read", key: "k1", preview: '{"path":"a"}' };
  assert.equal(w.observe(call), null);
  assert.equal(w.observe(call), null);
  const first = w.observe(call);
  assert.equal(first?.count, 3);
  assert.equal(w.observe(call)?.count, 4);
});

test("RepeatWatcher ignores a different key", () => {
  const w = new RepeatWatcher(3);
  for (let i = 0; i < 5; i++) {
    w.observe({ name: "read", key: `k${i}`, preview: "" });
  }
  assert.equal(w.repeat, null);
});
