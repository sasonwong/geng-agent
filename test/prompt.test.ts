import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "../internal/prompt.ts";

test("the system prompt carries only what the operator controls", () => {
  const text = composeSystemPrompt("/state是你，/work 是你干活的地方，网络是通的。", "可以调的运行参数：defaultWakeMinutes=30。");
  assert.match(text, /^\/state是你/);
  assert.match(text, /网络是通的。\n\n可以调的运行参数：defaultWakeMinutes=30。\n$/);
  // nothing about who it is: it rewrites that file whenever it likes, and anything it can
  // rewrite must not sit in front of the tools block
  assert.doesNotMatch(text, /你写下的自己/);
});

test("with no facts the frame stands alone", () => {
  assert.equal(composeSystemPrompt("你是。 \n\n"), "你是。\n");
});
