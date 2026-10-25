import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../internal/command.ts";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";

test("the container's /state/outbox is the directory the gateway reads", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const { args } = buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice");

  const at = args.indexOf(`${paths.outbox}:/state/outbox`);
  assert.notEqual(at, -1, "outbox 没有挂进容器：say 写的话没人读");

  // and it must not shadow the whole /state mount that comes first
  const stateAt = args.indexOf(`${paths.palimpsest}:/state`);
  assert.ok(stateAt !== -1 && stateAt < at, "/state 要在 /state/outbox 之前挂");
});
