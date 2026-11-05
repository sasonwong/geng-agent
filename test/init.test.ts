import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initInstance } from "../internal/init.ts";
import { makePaths } from "../internal/paths.ts";
import { readModelKey, modelKeyFile, modelUpstream } from "../internal/model.ts";

/** A root with the two templates `init` copies, so the test does not depend on the repo. */
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "geng-init-"));
  mkdirSync(join(r, "deploy"), { recursive: true });
  writeFileSync(
    join(r, "deploy", "policy.json"),
    JSON.stringify({ schema: 1, cycle: { timeoutSec: 1800 }, container: { image: "geng-agent:latest" } }),
  );
  writeFileSync(join(r, "deploy", "settings.json"), JSON.stringify({ defaultProvider: "p", defaultModel: "m" }));
  return r;
}

test("init writes the four values that are about this instance, not the project", () => {
  const r = root();
  initInstance(r, "alice", {
    image: "geng-agent:9.9",
    timeoutMin: 45,
    model: "some/model",
    upstream: "https://example.invalid/v1",
    modelKey: "testkey",
  });
  const p = makePaths(r, "alice");

  const policy = JSON.parse(readFileSync(p.policy, "utf8"));
  assert.equal(policy.container.image, "geng-agent:9.9");
  // minutes in, seconds on disk: the unit is the one the round reads
  assert.equal(policy.cycle.timeoutSec, 45 * 60);
  // untouched keys stay the template's — init is not a policy editor
  assert.equal(policy.schema, 1);

  const settings = JSON.parse(readFileSync(join(p.piDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "some/model");
  assert.equal(settings.defaultProvider, "p");

  // the key and the address are read back through the same functions the daemon uses
  assert.deepEqual(readModelKey(p), { name: "OPENCODE_API_KEY", key: "testkey" });
  assert.equal(modelUpstream(p), "https://example.invalid/v1");
  // per instance: a second instance must not inherit the first one's key
  assert.notEqual(modelKeyFile(p), join(r, "secrets", "model.env"));
});

test("without flags the template's values survive, and the key file is still created", () => {
  const r = root();
  initInstance(r, "bob");
  const p = makePaths(r, "bob");
  const policy = JSON.parse(readFileSync(p.policy, "utf8"));
  assert.equal(policy.container.image, "geng-agent:latest");
  assert.equal(policy.cycle.timeoutSec, 1800);
  assert.equal(readModelKey(p), null, "空模板不该算配好了");
  assert.equal(modelUpstream(p), "https://opencode.ai/inference/go/v1");
});

test("a rerun with a key or an upstream reaches the file that already exists", () => {
  // the CLI prints "把 key 写进这里，或 export 后重跑 init"; the rerun used to be a no-op
  // over an existing file, reporting success while the wrong key stayed in place
  const r = root();
  initInstance(r, "carol", { modelKey: "first" });
  const p = makePaths(r, "carol");
  assert.equal(readModelKey(p)?.key, "first");

  initInstance(r, "carol", { modelKey: "second", upstream: "https://other.invalid/v1" });
  assert.equal(readModelKey(p)?.key, "second", "重跑要换掉旧 key");
  assert.equal(readModelKey(p)?.name, "OPENCODE_API_KEY", "沿用文件里已有的名字，不再长出第二个");
  assert.equal(modelUpstream(p), "https://other.invalid/v1", "重跑要换掉旧地址");

  // a rerun without a key does not blank what is there
  initInstance(r, "carol", {});
  assert.equal(readModelKey(p)?.key, "second");
  assert.equal(modelUpstream(p), "https://other.invalid/v1");
});
