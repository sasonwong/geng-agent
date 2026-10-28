import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystemPrompt } from "../internal/prompt.ts";
import { systemFacts } from "../internal/packet.ts";

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

test("the time budget is a fact of the frame, stated and not advised", () => {
  const facts = systemFacts([], "defaultWakeMinutes=30", 30);
  assert.match(facts, /每一轮最多 30 分钟，到点会被杀掉。/);
  // no place to speak: nothing about it, and no sentence telling it what to do with the time
  assert.doesNotMatch(facts, /能说话的地方/);
  assert.doesNotMatch(facts, /少做|注意|建议|尽量|别浪费/);
});
