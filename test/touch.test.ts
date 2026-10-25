import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTouched } from "../internal/touch.ts";

test("only files written after the last waking are counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "old.md"), "x");
  utimesSync(join(dir, "old.md"), new Date(1_000_000), new Date(1_000_000));
  writeFileSync(join(dir, "notes", "new.md"), "x");
  // the old file sits at t=1e6, so "since" must be after that, not before
  assert.equal(countTouched(dir, 2_000_000), 1);
});

test("node_modules is skipped, and a missing directory counts as nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "a.js"), "x");
  writeFileSync(join(dir, "a.md"), "x");
  assert.equal(countTouched(dir, 0), 1);
  assert.equal(countTouched(join(dir, "nope"), 0), 0);
});
