import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWaiting } from "../internal/schedule.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const f = join(dir, "waiting.json");
  writeFileSync(f, content);
  return f;
}

test("readWaiting parses a relative alarm", () => {
  const now = Date.parse("2026-03-02T00:00:00Z");
  const f = tmpFile(JSON.stringify({ wake: { after: "20m" }, why: "等 CI" }));
  const spec = readWaiting(f, now);
  assert.equal(spec?.dueAtMs, now + 20 * 60_000);
  assert.equal(spec?.why, "等 CI");
});

test("readWaiting parses an absolute alarm", () => {
  const now = Date.parse("2026-03-02T00:00:00Z");
  const f = tmpFile(JSON.stringify({ wake: { at: "2026-03-02T01:00:00Z" } }));
  assert.equal(readWaiting(f, now)?.dueAtMs, Date.parse("2026-03-02T01:00:00Z"));
});

test("readWaiting returns null when no alarm was set", () => {
  const now = Date.now();
  assert.equal(readWaiting(join(tmpdir(), "geng-no-such-file.json"), now), null);
  assert.equal(readWaiting(tmpFile("{not json"), now), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ why: "我忘了" })), now), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ wake: { after: "20 minutes" } })), now), null);
});
