import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildPacket, type PacketInput } from "../internal/packet.ts";
import { makePaths } from "../internal/paths.ts";
import { writeJson, writeText } from "../internal/state.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function fixture(): { root: string; input: (over: Partial<PacketInput>) => PacketInput } {
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
    maxBytes: 8192,
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
  return { root, input: (over) => ({ ...base, ...over }) };
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
    input({ reason: "knock", inbox: [{ id: "1", text: "在吗", from: "telegram:@you" }] }),
  );
  assert.match(knocked, /有人敲门/);
  assert.match(knocked, /说句话回去/);
  assert.doesNotMatch(knocked, /现在没人在跟你说话/);
});

test("nudge admits it was woken by default rather than by an alarm", () => {
  const { input } = fixture();
  assert.match(buildPacket(input({ reason: "nudge" })), /没有留下下次什么时候醒/);
});

test("open loops carry their age", () => {
  const { input } = fixture();
  const i = input({});
  writeJson(i.paths.openLoops, [
    { title: "弄清一个问题", since: "2026-03-01T09:00:00Z", state: "查过两次" },
  ]);
  const text = buildPacket(i);
  assert.match(text, /弄清一个问题 · 搁了 24\.0h · 查过两次/);
});

test("a long gap is stated as a fact, not an excuse", () => {
  const { input } = fixture();
  assert.match(buildPacket(input({ longGap: true })), /机器可能停过/);
});

test("a changed environment is stated, not explained", () => {
  const { input } = fixture();
  const text = buildPacket(input({ envChanged: "环境变了：镜像 3f2a1b9c → 9c8d7e01。" }));
  assert.match(text, /环境变了：镜像 3f2a1b9c → 9c8d7e01/);
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

test("packet is truncated rather than overflowing", () => {
  const { input } = fixture();
  const i = input({ maxBytes: 200 });
  writeText(i.paths.identity, "x".repeat(4000));
  assert.ok(Buffer.byteLength(buildPacket(i), "utf8") < 400);
});
