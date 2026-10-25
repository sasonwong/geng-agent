import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEnvChange } from "../internal/env.ts";

const id = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

test("the first waking has nothing to compare against", () => {
  assert.equal(describeEnvChange(undefined, { imageId: id("a"), version: "0.1.0" }), null);
});

test("an unchanged environment says nothing", () => {
  const env = { imageId: id("a"), version: "0.1.0" };
  assert.equal(describeEnvChange(env, env), null);
});

test("a rebuilt image and a new version are stated as facts", () => {
  const before = { imageId: id("a"), version: "0.1.0" };
  const after = { imageId: id("b"), version: "0.2.0" };
  assert.equal(
    describeEnvChange(before, after),
    "环境变了：镜像 aaaaaaaa → bbbbbbbb，程序 0.1.0 → 0.2.0。",
  );
});
