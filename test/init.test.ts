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

test("two instances actually get two different keys and upstreams", () => {
  // 旧断言只说「路径不是那个共享的 model.env」。它证明不了隔离：文件可能都叫那个
  // 名字、也可能第二份把第一份覆盖了。真要验的是读回来的是谁的值。
  const aliceKey = ["key-for-", "alice"].join("");
  const bobKey = ["key-for-", "bob"].join("");
  const r = root();
  initInstance(r, "alice", { modelKey: aliceKey, upstream: "https://alice.invalid/v1" });
  initInstance(r, "bob", { modelKey: bobKey, upstream: "https://bob.invalid/v1" });
  const a = makePaths(r, "alice");
  const b = makePaths(r, "bob");

  assert.notEqual(modelKeyFile(a), modelKeyFile(b));
  assert.deepEqual(readModelKey(a), { name: "OPENCODE_API_KEY", key: aliceKey });
  assert.deepEqual(readModelKey(b), { name: "OPENCODE_API_KEY", key: bobKey });
  assert.equal(modelUpstream(a), "https://alice.invalid/v1");
  assert.equal(modelUpstream(b), "https://bob.invalid/v1");

  // CLI 让操作者「export 后重跑 init」来改一个填错的 key / upstream。旧实现只在
  // model.env 不存在时写，重跑会报成功却什么都没改——reader 永远读着那把旧 key。
  const freshKey = ["fresh-key-for-", "bob"].join("");
  initInstance(r, "bob", { modelKey: freshKey, upstream: "https://other.invalid/v1" });
  assert.deepEqual(readModelKey(b), { name: "OPENCODE_API_KEY", key: freshKey }, "重跑要真的换上新 key");
  assert.equal(modelUpstream(b), "https://other.invalid/v1", "重跑要真的换上新 upstream");
  // 但 bob 的重跑不能顺手改掉 alice
  assert.deepEqual(readModelKey(a), { name: "OPENCODE_API_KEY", key: aliceKey });
  assert.equal(modelUpstream(a), "https://alice.invalid/v1");
  // 不带新值重跑则保持不动（CLI 没 export key 时就是这条路径）
  initInstance(r, "bob");
  assert.deepEqual(readModelKey(b), { name: "OPENCODE_API_KEY", key: freshKey });
  assert.equal(modelUpstream(b), "https://other.invalid/v1");
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
