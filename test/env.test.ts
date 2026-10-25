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

test("a change is stated without identifiers it cannot look up", () => {
  const before = { imageId: id("a"), version: "0.1.0", search: false };
  assert.equal(describeEnvChange(before, { imageId: id("b"), version: "0.1.0" }), "环境变了。");
  // a program bump alone says nothing: the tool surface did not change
  assert.equal(describeEnvChange(before, { imageId: id("a"), version: "0.2.0" }), null);
  // but a new tool does, even when the image stays the same
  assert.equal(describeEnvChange(before, { imageId: id("a"), version: "0.1.0", search: true }), "环境变了。");
  // no hash, no version, no advice about tools
  const said = describeEnvChange(before, { imageId: id("b"), version: "0.2.0" }) ?? "";
  assert.doesNotMatch(said, /[0-9a-f]{8}|0\.|工具|建议/);
});
