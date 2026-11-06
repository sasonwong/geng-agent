import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstance } from "../internal/doctor.ts";
import { makePaths } from "../internal/paths.ts";

// `session/` became `sessions/` in v0.0.1. A directory that was renamed once is a
// directory that gets missed silently: the daemon starts writing into the new name and the
// old sessions look like they were never there. doctor is the only thing that can say so,
// because nothing else reads a path it has stopped using.
test("a data dir that still has session/ is flagged, and silence means it was migrated", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-layout-"));
  try {
    const paths = makePaths(root, "alice");
    mkdirSync(paths.data, { recursive: true });
    const old = join(paths.data, "session");
    mkdirSync(old);
    const flagged = checkInstance(root, "alice", false).find((c) => c.name === "session 目录改名");
    assert.ok(flagged, "旧目录还在的时候什么都没报");
    assert.equal(flagged?.ok, false);
    assert.match(String(flagged?.detail), /sessions\//);

    rmSync(old, { recursive: true, force: true });
    assert.equal(
      checkInstance(root, "alice", false).find((c) => c.name === "session 目录改名"),
      undefined,
      "迁好之后还挂着一条永远红的检查",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
