import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildPacket, type PacketInput } from "../internal/packet.ts";
import { makePaths } from "../internal/paths.ts";
import { writeJson, writeText } from "../internal/state.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function fixture(): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  input: (over: Partial<PacketInput>) => PacketInput;
} {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  for (const d of [paths.palimpsest, paths.journal, paths.inbox, paths.workspace, paths.meta]) {
    mkdirSync(d, { recursive: true });
  }
  const base: PacketInput = {
    paths,
    nowMs: Date.parse("2026-03-02T09:00:00Z"),
    reason: "timer",
    waitWhy: null,
    lastWakeMs: Date.parse("2026-03-02T08:00:00Z"),
    waking: 2,
    statePath: "/state",
    workPath: "/work",
    inbox: [],
    mutes: {},
    crashed: false,
    longGap: false,
    hint: null,
    wakes24h: 1,
    parked: false,
    lowPending: 0,
    policyLine: "defaultWakeMinutes=30",
    searchLeft: 12,
    envChanged: null,
  };
  return { root, paths, input: (over) => ({ ...base, ...over }) };
}

test("birth packet says nothing about who it is, and permits doing nothing", () => {
  const { input } = fixture();
  const text = buildPacket(input({ waking: 1, lastWakeMs: null }));
  assert.match(text, /这是你第一次醒来/);
  // birth must not claim it woke itself up, and must not count a 24h window
  assert.doesNotMatch(text, /被自己定的闹钟叫醒|最近 24 小时醒了/);
  assert.match(text, /你可以什么都不做，那不算失败/);
  assert.match(text, /先写下你是谁/);
  assert.match(text, /没人在跟你说话/);
});

test("birth packet keeps counting when the identity is still missing", () => {
  const { input } = fixture();
  const text = buildPacket(input({ waking: 7 }));
  assert.match(text, /你第 7 次醒来，你还没有写过你是谁/);
});

test("a written identity replaces the birth framing", () => {
  const { input } = fixture();
  const i = input({});
  writeText(i.paths.identity, "我是 alice。");
  const text = buildPacket(i);
  assert.match(text, /^我是 alice。/);
  assert.doesNotMatch(text, /先写下你是谁/);
  assert.match(text, /你可以什么都不做/);
});

test("knock and timer read differently, and a knock is addressed", () => {
  const { input } = fixture();
  const knocked = buildPacket(
    input({ reason: "knock", inbox: [{ id: "1", file: "1.json", text: "在吗", from: "telegram:@you" }] }),
  );
  assert.match(knocked, /有人敲门/);
  assert.match(knocked, /说句话回去/);
  assert.doesNotMatch(knocked, /现在没人在跟你说话/);
});

test("nudge admits it was woken by default rather than by an alarm", () => {
  const { input } = fixture();
  assert.match(buildPacket(input({ reason: "nudge" })), /没有留下下次什么时候醒/);
});

test("open loops are counted and pointed at, not pasted", () => {
  const { input } = fixture();
  const i = input({});
  writeJson(i.paths.openLoops, [
    { title: "弄清一个问题", since: "2026-03-01T09:00:00Z", state: "查过两次" },
    { title: "第二件", since: "2026-03-02T08:00:00Z" },
  ]);
  const text = buildPacket(i);
  assert.match(text, /未闭合的事：2 条，在 \/state\/open-loops\.json。/);
  // the title is for the agent to dig out, not for the daemon to summarize
  assert.doesNotMatch(text, /弄清一个问题/);
});

test("a long gap is stated as a fact, not an excuse", () => {
  const { input } = fixture();
  assert.match(buildPacket(input({ longGap: true })), /机器可能停过/);
});

test("a changed environment is stated, not explained", () => {
  const { input } = fixture();
  const text = buildPacket(input({ envChanged: "环境变了。" }));
  assert.match(text, /环境变了。/);
  // no advice attached: what the new tools mean is its call, not ours
  assert.doesNotMatch(text, /工具|建议|应该/);
  assert.doesNotMatch(buildPacket(input({ envChanged: null })), /环境变了/);
});

test("search quota is stated as a fact it can weigh", () => {
  const { input } = fixture();
  const build = (over: Partial<PacketInput>) => buildPacket(input(over));

  const withQuota = build({ searchLeft: 12 });
  assert.match(withQuota, /今天还能搜 12 次/);

  const exhausted = build({ searchLeft: 0 });
  assert.match(exhausted, /今天的搜索用完了/);

  const unconfigured = build({ searchLeft: null });
  assert.doesNotMatch(unconfigured, /搜索/);
});

test("the page stays bounded without being cut: nothing external is pasted", () => {
  const { input, paths } = fixture();
  const many = Array.from({ length: 200 }, (_, n) => ({
    id: String(n),
    file: `${n}.json`,
    text: "很长的一句话。".repeat(100),
    from: "telegram:@someone",
  }));
  writeText(
    paths.openLoops,
    JSON.stringify(Array.from({ length: 200 }, (_, n) => ({ title: `第 ${n} 件事`, since: "2026-03-01T00:00:00Z" }))),
  );
  const text = buildPacket(input({ inbox: many, lowPending: 500 }));
  assert.ok(Buffer.byteLength(text, "utf8") < 2500, `page grew to ${Buffer.byteLength(text, "utf8")}`);
  assert.match(text, /有人在跟你说话：200 条，在 \/state\/inbox\/。/);
  assert.match(text, /未闭合的事：200 条/);
});

test("a mute is stated as state, and says plainly that it changes nothing", () => {
  const { input } = fixture();
  const text = buildPacket(input({ mutes: { "chat:-1001234": { until: "2026-03-02T09:00:00Z" } } }));
  assert.match(text, /你静音了 chat:-1001234（到 2026-03-02T09:00:00Z）/);
  assert.match(text, /不改变投递/);
  assert.doesNotMatch(buildPacket(input({ mutes: {} })), /静音/);
});
