import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { maybeBackup, backupRepo, listSnapshots, parseSnapshots, restore, restoredLooksWhole, writeDeployMeta } from "../internal/backup.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  for (const d of [paths.book, paths.meta, paths.sessionDir, paths.workspace]) {
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

test("deploy.json says which build wrote the snapshot, and nothing else", () => {
  // Three fields used to be written here: a version (read by doctor), a policy schema and
  // an image digest (read by nobody, and the digest file was written by nothing). A field
  // nobody reads is a promise that something keeps it current.
  const paths = fixture();
  writeFileSync(join(paths.root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeDeployMeta(paths);
  assert.deepEqual(JSON.parse(readFileSync(join(paths.meta, "deploy.json"), "utf8")), {
    daemonVersion: "1.2.3",
  });
});

test("a restored tree is found even when rustic nests the absolute paths", () => {
  const paths = fixture();
  const target = join(paths.root, "restored");
  const nested = join(target, "tmp", "geng", "data", "alice");
  mkdirSync(join(nested, "book"), { recursive: true });
  mkdirSync(join(nested, "meta"), { recursive: true });
  mkdirSync(join(nested, "sessions"), { recursive: true });
  writeFileSync(join(nested, "book", "identity.md"), "我是 alice\n");
  writeFileSync(join(nested, "meta", "deploy.json"), "{}\n");

  assert.deepEqual(restoredLooksWhole(target), { ok: true, missing: [] });
});

test("a snapshot from before the rename has session/, and it is still whole", () => {
  // Restores are for the day it went wrong. If today's directory name were required, every
  // snapshot taken before the rename would read as broken.
  const paths = fixture();
  const target = join(paths.root, "old");
  const nested = join(target, "data", "alice");
  mkdirSync(join(nested, "book"), { recursive: true });
  mkdirSync(join(nested, "meta"), { recursive: true });
  mkdirSync(join(nested, "session"), { recursive: true });
  writeFileSync(join(nested, "book", "identity.md"), "我是 alice\n");
  writeFileSync(join(nested, "meta", "deploy.json"), "{}\n");
  assert.deepEqual(restoredLooksWhole(target), { ok: true, missing: [] });
});

test("an empty or partial restore is reported, not passed", () => {
  const paths = fixture();
  const target = join(paths.root, "empty");
  mkdirSync(target, { recursive: true });
  const result = restoredLooksWhole(target);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["book/"]);
});

test("both rustic snapshot JSON shapes parse", () => {
  const entry = {
    id: "0000000000000000000000000000000000000000000000000000000000000000",
    time: "2026-01-01T00:00:00Z",
    summary: { total_files_processed: 7 },
  };
  const old = parseSnapshots(JSON.stringify([[{ hostname: "demo" }, [entry]]]));
  const newer = parseSnapshots(JSON.stringify([{ group_key: { hostname: "demo" }, snapshots: [entry] }]));
  assert.notEqual(old, null);
  assert.notEqual(newer, null);
  assert.deepEqual(old, newer);
  assert.equal(old?.[0]?.id, entry.id);
  assert.equal(old?.[0]?.files, 7);
});

test("parseSnapshots 把读不出的输出和空列表分开", () => {
  // 旧实现把 JSON 报错和顶层不是数组都吞成 []，于是「读不出」和「零张快照」长得一样。
  assert.equal(parseSnapshots("not json"), null);
  assert.equal(parseSnapshots("{}"), null, "顶层不是数组也算读不出");
  assert.equal(parseSnapshots("42"), null);
  assert.deepEqual(parseSnapshots("[]"), [], "空数组是「零张」，不是读不出");
});

test("listSnapshots 把「读不出」和「没有快照」分开", async () => {
  const paths = fixture(); // 没有 secrets/rustic.env
  const list = await listSnapshots(paths);
  // 旧实现返回的是裸数组 []，.ok 是 undefined：读不出和空列表完全没区别。
  assert.equal(list.ok, false);
  assert.deepEqual(list.snapshots, []);
  assert.match(list.detail ?? "", /密码|rustic/, "读不出要带上原因");
});

test("restore 在仓库读不出时说「读不出快照列表」，不是「没有快照」", async () => {
  const paths = fixture();
  mkdirSync(join(paths.root, "secrets"), { recursive: true });
  writeFileSync(join(paths.root, "secrets", "rustic.env"), "RUSTIC_PASSWORD=test-only\n");
  mkdirSync(backupRepo(paths), { recursive: true });
  writeFileSync(join(backupRepo(paths), "config"), "not a real rustic repository\n");
  const result = await restore({ paths, target: join(paths.root, "restored") });
  assert.equal(result.ok, false);
  // 旧实现拿到空列表就报「没有快照」，把一个根本连不上的仓库说成还没拍过。
  assert.match(result.detail, /读不出快照列表/);
  assert.doesNotMatch(result.detail, /^没有快照$/);
});
