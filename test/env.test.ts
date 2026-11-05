import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEnvChange } from "../internal/env.ts";

const id = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;

test("the first waking has nothing to compare against", () => {
  assert.equal(describeEnvChange(undefined, { imageId: id("a") }), null);
});

test("an unchanged environment says nothing", () => {
  const env = { imageId: id("a") };
  assert.equal(describeEnvChange(env, env), null);
});

test("a change is stated without identifiers it cannot look up", () => {
  const before = { imageId: id("a"), search: false };
  assert.equal(describeEnvChange(before, { imageId: id("b") }), "环境变了。");
  // but a new tool does, even when the image stays the same
  assert.equal(describeEnvChange(before, { imageId: id("a"), search: true }), "环境变了。");
  // no hash, no version, no advice about tools
  const said = describeEnvChange(before, { imageId: id("b") }) ?? "";
  assert.doesNotMatch(said, /[0-9a-f]{8}|0\.|工具|建议/);
});

test("an image id it could not read is not a change", () => {
  const before = { imageId: id("a"), search: false };
  // docker was unreachable when the page was built: "could not tell" must not be
  // reported as "different", or every docker hiccup tells the agent its world changed
  assert.equal(describeEnvChange(before, { imageId: null }), null);
  // the other direction is a real change: a life that used to have no image at all
  assert.equal(describeEnvChange({ imageId: null }, { imageId: id("a") }), "环境变了。");
});
