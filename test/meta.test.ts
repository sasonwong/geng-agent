import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { DAY_MS, readMeta, readWakes, recordWake, spentThisCycle, writeMeta } from "../internal/meta.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  return paths;
}

test("meta reads what the daemon wrote, not an older layout", () => {
  const paths = fixture();
  assert.deepEqual(readMeta(paths), {});
  writeMeta(paths, { lastWakeMs: 1_000, wakings: 3, sessionGen: 1 });
  assert.deepEqual(readMeta(paths), { lastWakeMs: 1_000, wakings: 3, sessionGen: 1 });
});

test("wake history keeps only the last 24 hours", () => {
  const paths = fixture();
  const now = Date.parse("2026-03-02T12:00:00Z");
  recordWake(paths, now - DAY_MS - 60_000); // too old to count
  recordWake(paths, now - 60_000);
  const count = recordWake(paths, now);
  assert.equal(count, 2);
  assert.equal(readWakes(paths, now).length, 2);
});

test("per-cycle spend is the difference, because pi counts for the whole session", () => {
  const before = { tokens: 1_000_000, cost: 0.02 };
  const cycle = spentThisCycle(before, { tokens: 1_040_000, cost: 0.0208 });
  assert.equal(cycle?.tokens, 40_000);
  assert.ok(Math.abs((cycle?.cost ?? 0) - 0.0008) < 1e-9);
  // a fresh session starts again from zero: that is not a refund
  assert.deepEqual(spentThisCycle(before, { tokens: 12_000, cost: 0.0002 }), { tokens: 0, cost: 0 });
  assert.equal(spentThisCycle(before, null), null);
});
