import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "../internal/prompt.ts";

test("the identity it wrote is the last section of the system prompt", () => {
  const text = composeSystemPrompt("你在一个容器里。\n\n## 你上次醒来时写下的自己\n", "# 我是谁\n我是 alice。");
  assert.match(text, /^你在一个容器里。/);
  assert.match(text, /## 你上次醒来时写下的自己\n\n# 我是谁\n我是 alice。\n$/);
});

test("on the first waking that section is simply empty", () => {
  const base = "你在一个容器里。\n\n## 你上次醒来时写下的自己\n";
  assert.equal(composeSystemPrompt(base, null), composeSystemPrompt(base, ""));
  // the heading stays: the slot exists, nothing is invented to fill it
  assert.match(composeSystemPrompt(base, null), /## 你上次醒来时写下的自己\n\n$/);
});
