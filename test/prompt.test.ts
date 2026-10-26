import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "../internal/prompt.ts";

test("the identity it wrote is the last section of the system prompt", () => {
  const text = composeSystemPrompt("你在一个容器里。", "# 我是谁\n我是 alice。");
  assert.match(text, /^你在一个容器里。/);
  assert.match(text, /## 你写下的自己\n\n# 我是谁\n我是 alice。\n$/);
});

test("on the first waking that section is simply empty", () => {
  const base = "你在一个容器里。";
  assert.equal(composeSystemPrompt(base, null), composeSystemPrompt(base, ""));
  // the heading stays: the slot exists, nothing is invented to fill it
  assert.match(composeSystemPrompt(base, null), /## 你写下的自己\n\n?\n$/);
});

test("the rare facts sit between the frame and the self, so the tools stay cacheable", () => {
  const base = "/state是你，/work 是你干活的地方，网络是通的。";
  const text = composeSystemPrompt(base, "# 我\n我是 alice。", "可以调的运行参数：defaultWakeMinutes=30。");
  // frame first, then the two operator facts, then the self: anything that changes every
  // waking must stay in the user turn instead, because the tools block sits right below
  assert.match(text, /网络是通的。\n\n可以调的运行参数：defaultWakeMinutes=30。\n\n## 你写下的自己\n\n# 我\n我是 alice。\n$/);
});
