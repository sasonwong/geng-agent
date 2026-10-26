import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../internal/command.ts";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";

test("the container's /outbox is the directory the gateway reads", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const { args } = buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…");

  assert.notEqual(args.indexOf(`${paths.outbox}:/outbox`), -1, "outbox 没有挂进容器：say 写的话没人读");
})
test("only what the page points at is mounted, and never the rules", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const argv = buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…").args.join(" ");
  assert.match(argv, new RegExp(`-v ${paths.inbox}:/inbox:ro`));
  assert.match(argv, new RegExp(`-v ${paths.people}:/people:ro`));
  // the rules it lives under are not exposed at all: no mount, and the file now lives
  // outside the book, so the /state bind cannot carry it in either
  assert.equal(argv.includes("/daemon.log"), false, "daemon.log 不挂了");
  assert.equal(argv.includes("policy.json"), false, "policy.json 不该出现在容器里");
  assert.equal(paths.policy.startsWith(paths.palimpsest), false, "policy.json 不在 /state 里");
  // nothing may be nested under the /state bind: docker would create the mountpoint
  // through it, as root, inside the agent's own book
  for (const target of [":/state/inbox", ":/state/daemon.log", ":/state/people", ":/state/outbox"]) {
    assert.equal(argv.includes(target), false, `${target} 挂在 /state 里面了`);
  }
});

test("the tools are loaded from outside the agent's home", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const { args } = buildCommand(makePaths(root, "alice"), { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…");
  const joined = args.join(" ");
  assert.match(joined, /-e \/opt\/geng\/extensions\/say-mute\.ts/);
  assert.match(joined, /-e \/opt\/geng\/extensions\/websearch\.ts/);
});
