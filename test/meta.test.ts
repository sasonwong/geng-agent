import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { clearCut, DAY_MS, readCut, readMeta, readWakes, recordWake, writeCut, writeMeta } from "../internal/meta.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  return paths;
}

test("meta reads what the daemon wrote, not an older layout", () => {
  const paths = fixture();
  assert.deepEqual(readMeta(paths), {});
  writeMeta(paths, { lastWakeMs: 1_000, wakings: 3, lastSaid: "先去看 cgroup" });
  // the schema stamp is added by the writer, so no call site can forget it
  assert.deepEqual(readMeta(paths), {
    lastWakeMs: 1_000,
    wakings: 3,
    lastSaid: "先去看 cgroup",
    stateSchema: 1,
  });
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

test("a cut note is written, read back whole, and cleared", () => {
  const paths = fixture();
  assert.equal(readCut(paths), null, "nothing was written yet");

  const rec = {
    kind: "timeout" as const,
    at: "2026-03-02T08:30:00Z",
    waking: 212,
    reason: "knock",
    tools: ["bash md5sum v8.md"],
    openMs: 720_000,
  };
  writeCut(paths, rec);
  // read back through the real reader: a field the reader drops is a field that never
  // reached the page, which is how attachments once went missing
  assert.deepEqual(readCut(paths), rec);

  clearCut(paths);
  assert.equal(readCut(paths), null);
});

test("a cut note that nothing can read is worth less than a waking that starts", () => {
  const paths = fixture();
  writeCut(paths, { kind: "timeout", at: "x", waking: 1, reason: "timer" });
  // someone hand-edited it into something that is not a note
  writeFileSync(join(paths.meta, "cut.json"), '{"kind":"nonsense"}');
  assert.equal(readCut(paths), null);
});
