import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printStatus } from "../internal/status.ts";
import { makePaths } from "../internal/paths.ts";
import { writeText } from "../internal/state.ts";

test("status counts open loops the way the page does: files, not the old JSON shape", async () => {
  // `open-loops` used to be a single JSON file and became one file per thing. Reading it
  // as JSON now throws EISDIR and falls back to [], so status said 0 no matter what.
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = makePaths(root, "alice");
  mkdirSync(join(p.openLoops, "closed"), { recursive: true });
  writeText(join(p.openLoops, "一件.md"), "x");
  writeText(join(p.openLoops, "closed", "已闭.md"), "x");

  const lines: string[] = [];
  const old = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    await printStatus(root, "alice");
  } finally {
    console.log = old;
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(lines.join("\n"), /未闭合\s+1 件/);
});
