import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBot, botProblems, describeBot, editAllow, readBots, writeBots } from "../internal/bots.ts";

/** A root with a data/ tree, because "@me resolves to nobody" looks the same as "no PRs". */
function root(instances: string[] = ["alice"]): string {
  const d = mkdtempSync(join(tmpdir(), "geng-bots-"));
  mkdirSync(join(d, "secrets"), { recursive: true });
  for (const i of instances) mkdirSync(join(d, "data", i), { recursive: true });
  return d;
}

// 值里带 "fake" 是给门看的：tools/gate/patterns.mjs 的 PLACEHOLDERS 让整行跳过，所以
// 这些假 token 不必长得像真的。去掉这个词，门会在测这个测试之前先红。
test("adding a bot keeps the other bots and every field it was not asked about", () => {
  const d = root();
  writeBots(d, { ops: { token: "fake-ops", chat: 111 }, alice: { token: "old", allow: [1] } });

  addBot(d, "alice", { token: "new", listen: "mentions" });

  const bots = readBots(d);
  assert.equal(bots.ops?.token, "fake-ops", "unrelated bot untouched");
  assert.equal(bots.alice?.token, "new");
  assert.equal(bots.alice?.listen, "mentions");
  assert.deepEqual(bots.alice?.allow, [1], "a field it was not asked about survives");

  addBot(d, "bob", { token: "fake-bob", allow: [] });
  assert.deepEqual(Object.keys(readBots(d)).sort(), ["alice", "bob", "ops"]);
});

test("the whitelist is edited as a union, so a second call cannot silently drop an id", () => {
  const d = root(["alice"]);
  addBot(d, "alice", { token: "t", allow: [1, 2] });

  editAllow(d, "alice", [3], []);
  assert.deepEqual(readBots(d).alice?.allow, [1, 2, 3]);

  editAllow(d, "alice", [1], []); // adding an existing id is a no-op, not a duplicate
  assert.deepEqual(readBots(d).alice?.allow, [1, 2, 3]);

  editAllow(d, "alice", [], [2]);
  assert.deepEqual(readBots(d).alice?.allow, [1, 3]);

  assert.throws(() => editAllow(d, "nobody", [1], []), /没有 nobody/);
});

test("bots.json is written atomically and 600, because it is nothing but tokens", () => {
  const d = root();
  writeBots(d, { alice: { token: "t" } });
  const file = join(d, "secrets", "bots.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { alice: { token: "t" } });
  assert.equal(readBots(join(d, "nowhere")).alice, undefined, "an absent file is an empty map");
});

test("the problems it reports are the ones that produce silence, not errors", () => {
  const bots = {
    ops: { token: "t" } as { token: string; chat?: number },
    alice: { token: "", listen: "loud" as unknown as "all" },
    bob: { token: "t" },
  };
  const problems = botProblems(bots as never, (key) => key === "alice");
  const text = problems.join("\n");
  assert.match(text, /ops：没有 chat/, "the ops bot cannot deliver without a chat");
  assert.match(text, /alice：没有 token/);
  assert.match(text, /alice：listen 只能是/);
  assert.match(text, /bob：data\/bob\/ 不存在/, "a bot with no instance can never wake anything");
});

test("the description says the three states apart, because allow=0 and allow=absent look the same", () => {
  assert.match(describeBot(undefined), /没有 bot/);
  assert.match(describeBot({ token: "t" }), /allow=不限/);
  assert.match(describeBot({ token: "t", allow: [] }), /0 人/);
  assert.match(describeBot({ token: "t", allow: [1, 2] }), /2 人/);
});
