import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actsFor, appendActs } from "../internal/acts.ts";
import type { ToolCall } from "../internal/rpc.ts";

function call(over: Partial<ToolCall> = {}): ToolCall {
  return { name: "bash", key: "k", preview: "{}", atMs: 0, durationMs: null, isError: false, ...over };
}

test("acts keep the order and number of the round, and carry the timing", () => {
  const lines = actsFor(212, [
    call({ name: "read", atMs: Date.parse("2026-03-02T09:00:00Z"), durationMs: 12 }),
    call({ name: "bash", atMs: Date.parse("2026-03-02T09:00:01Z"), isError: true }),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.waking, l.seq, l.tool, l.ms, l.err]),
    [
      [212, 1, "read", 12, false],
      [212, 2, "bash", null, true],
    ],
  );
  assert.equal(lines[0]?.at, "2026-03-02T09:00:00.000Z");
});

test("acts append instead of replacing: two rounds are two runs of lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-acts-"));
  const file = join(dir, "meta", "acts.jsonl");
  appendActs(file, actsFor(1, [call({ name: "read" })]));
  appendActs(file, actsFor(2, [call({ name: "bash" }), call({ name: "say" })]));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).tool),
    ["read", "bash", "say"],
  );
  assert.equal(JSON.parse(lines[2] as string).waking, 2);
});

