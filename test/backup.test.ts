import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { maybeBackup, backupRepo, restore, restoredLooksWhole } from "../internal/backup.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  for (const d of [paths.palimpsest, paths.meta, paths.sessionDir, paths.workspace]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(paths.policy, JSON.stringify(defaultPolicy()));
  return paths;
}

test("a disabled or password-less backup is a skip, not a failure", async () => {
  const paths = fixture();
  const off = await maybeBackup({
    paths,
    policy: { ...defaultPolicy(), backup: { enabled: false } },
    nowMs: Date.now(),
  });
  assert.deepEqual(off, { status: "skip", detail: "off" });

  const noPassword = await maybeBackup({ paths, policy: defaultPolicy(), nowMs: Date.now() });
  assert.deepEqual(noPassword, { status: "skip", detail: "no-password" });
});

test("restore refuses when there is nothing to restore from", async () => {
  const paths = fixture();
  const result = await restore({ paths, target: join(paths.root, "x") });
  assert.equal(result.ok, false);
  assert.match(result.detail, /rustic\.env|没有仓库/);
});

test("the repo lives outside the directory being backed up", () => {
  const paths = fixture();
  assert.equal(backupRepo(paths), join(paths.root, "backup", "alice"));
  assert.ok(!backupRepo(paths).startsWith(paths.data));
});

test("a restored tree is found even when rustic nests the absolute paths", () => {
  const paths = fixture();
  const target = join(paths.root, "restored");
  const nested = join(target, "tmp", "geng", "data", "alice");
  mkdirSync(join(nested, "palimpsest"), { recursive: true });
  mkdirSync(join(nested, "meta"), { recursive: true });
  mkdirSync(join(nested, "session"), { recursive: true });
  writeFileSync(join(nested, "palimpsest", "identity.md"), "我是 alice\n");
  writeFileSync(join(nested, "meta", "deploy.json"), "{}\n");

  assert.deepEqual(restoredLooksWhole(target), { ok: true, missing: [] });
});

test("an empty or partial restore is reported, not passed", () => {
  const paths = fixture();
  const target = join(paths.root, "empty");
  mkdirSync(target, { recursive: true });
  const result = restoredLooksWhole(target);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["palimpsest/"]);
});
