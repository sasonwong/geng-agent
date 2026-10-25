import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
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
