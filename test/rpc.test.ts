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

// Tools can run in parallel: two starts, one end, and a round killed with the second
// still running. A single open-call slot meant the one `end` erased the other's record,
// and the cut note said "nothing was running" over a live round.
test("an end retires one open call, not every open call", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runWaking } = await import("../internal/rpc.ts");
  const dir = mkdtempSync(join(tmpdir(), "geng-rpc-"));
  const fake = join(dir, "fake-pi.mjs");
  writeFileSync(
    fake,
    [
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => {",
      "  buf += c;",
      "  let nl;",
      "  while ((nl = buf.indexOf('\\n')) !== -1) {",
      "    const line = buf.slice(0, nl);",
      "    buf = buf.slice(nl + 1);",
      "    if (line.trim() === '') continue;",
      "    const rec = JSON.parse(line);",
      "    if (rec.type === 'prompt') {",
      "      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, data: { disposition: 'accepted' } }) + '\\n');",
      "      process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { cmd: 'a' } }) + '\\n');",
      "      process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'b' } }) + '\\n');",
      "      process.stdout.write(JSON.stringify({ type: 'tool_execution_end' }) + '\\n');",
      "      process.stdout.write(JSON.stringify({ type: 'agent_settled', aborted: true }) + '\\n');",
      "    } else {",
      "      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, data: {} }) + '\\n');",
      "    }",
      "  }",
      "});",
    ].join("\n"),
  );
  try {
    const r = await runWaking({
      command: { cmd: process.execPath, args: [fake], env: {}, cwd: dir },
      instance: "probe",
      timeoutMs: 20_000,
      prompt: "hi",
      repeatThreshold: 3,
    });
    assert.equal(r.settled, true);
    assert.equal(r.toolCalls.length, 2);
    assert.equal(r.openCall?.name, "read", "一个 end 只收掉一个 start，另一个还在跑");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
