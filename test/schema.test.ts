import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { onDiskSchema, schemaConflict, STATE_SCHEMA } from "../internal/schema.ts";
import { writeMeta } from "../internal/meta.ts";

test("a life from a newer build is refused, never silently downgraded", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  assert.equal(onDiskSchema(paths), null);
  assert.equal(schemaConflict(null), null);
  assert.match(schemaConflict(STATE_SCHEMA + 1) ?? "", /更新版本写的/);
  assert.equal(schemaConflict(STATE_SCHEMA), null);
  // older is readable: a migration may upgrade it later, nothing has to stop now
  assert.equal(schemaConflict(STATE_SCHEMA - 1), null);
});

test("the writer stamps the schema, so the file can never lack it", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  writeMeta(paths, { wakings: 1 });
  assert.equal(onDiskSchema(paths), STATE_SCHEMA);
});

test("an unstamped file is older, not unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  // written by a build that predates the stamp
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ wakings: 4 }));
  assert.equal(onDiskSchema(paths), 0);
  assert.equal(schemaConflict(0), null);
});

test("小数 / 负数 / 越界大数都不是版本号，按老文件处理", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ stateSchema: 1.5 }));
  assert.equal(onDiskSchema(paths), 0);
  assert.equal(schemaConflict(onDiskSchema(paths)), null, "一个小数不能让人误判成更新版本而拒绝启动");
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ stateSchema: -1 }));
  assert.equal(onDiskSchema(paths), 0);
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ stateSchema: STATE_SCHEMA + 0.5 }));
  assert.equal(onDiskSchema(paths), 0);
  assert.equal(schemaConflict(onDiskSchema(paths)), null);
  // 2^53 不是安全整数，也不能被当成「更新版本写的」
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ stateSchema: 2 ** 53 }));
  assert.equal(onDiskSchema(paths), 0);
});
