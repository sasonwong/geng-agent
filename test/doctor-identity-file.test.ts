import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstance } from "../internal/doctor.ts";
import { makePaths } from "../internal/paths.ts";

// readText returns null both for a missing file and for one whose bytes are not UTF-8.
// doctor used to print "还没写过" for the second, which sends the operator to write over a
// file that is already there. The wake packet splits the two; this check has to agree.
function identityCheck(bytes: Buffer | null): { ok: boolean; detail: string } {
  const root = mkdtempSync(join(tmpdir(), "geng-doc-id-"));
  try {
    const paths = makePaths(root, "alice");
    mkdirSync(paths.book, { recursive: true });
    if (bytes !== null) writeFileSync(paths.identity, bytes);
    const check = checkInstance(root, "alice", false).find((c) => c.name === "identity.md");
    assert.ok(check, "identity.md 这条检查必须一直在");
    return { ok: check.ok, detail: String(check.detail) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("no identity.md says it was never written", () => {
  const r = identityCheck(null);
  assert.equal(r.ok, false);
  assert.match(r.detail, /还没写过/);
});

test("identity.md with bytes that are not UTF-8 is not the same as never written", () => {
  // latin-1 é: a byte that cannot appear in UTF-8 text
  const r = identityCheck(Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
  assert.equal(r.ok, false);
  assert.match(r.detail, /UTF-8/);
  assert.doesNotMatch(r.detail, /还没写过/);
});

test("an identity.md with real text passes", () => {
  const r = identityCheck(Buffer.from("# 我\n", "utf8"));
  assert.equal(r.ok, true);
});
