import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeState } from "../internal/dev/fake.ts";
import { makePaths } from "../internal/paths.ts";
import { countLoops } from "../internal/packet.ts";

test("the fake state has the shape the page reads: one file per unfinished thing", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-fake-"));
  try {
    const p = makePaths(root, "alice");
    writeFakeState(p);
    // this used to be a JSON array written over the directory, so `geng-dev packet` died
    // on ensureDirs (EEXIST) and the page, when it did build, counted nothing
    assert.equal(countLoops(p), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
