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
    inboxPath: "/inbox",
    peoplePath: "/people",
    timezone: "Asia/Shanghai",
    places: [{ id: -1001234567890, label: "群「测试」", home: false }],
    attention: null,
    cut: null,
    filesPath: "/files",
    filesForgotten: 0,
    filesPruned: 0,
    filesOldestPrunedMs: null,
    filesUsedBytes: 0,
    filesCapMb: 500,
    inbox: [],
    mutes: {},
    longGap: false,
    hint: null,
    wakes24h: 1,
    parked: false,
    lowPending: 0,
    mailPending: { count: 0, senders: [], oldestMs: null },
    mailPath: "/mail",
    searchLeft: 12,
    envChanged: null,
    lastSaid: null,
    lastCycle: null,
    lastWords: null,
    thread: null,
    waiting: [],
    identity: null,
  };
  return { root, paths, input: (over) => ({ ...base, ...over }) };
}

test("birth packet says only what is new, and nothing about who it is", () => {
  const { input } = fixture();
  const text = buildPacket(input({ waking: 1, lastWakeMs: null }));
  assert.match(text, /这是你第一次醒来/);
  // birth must not claim it woke itself up, and must not count a 24h window
  assert.doesNotMatch(text, /被自己定的闹钟叫醒|最近 24 小时醒了/);
  assert.match(text, /你可以什么都不做，那不算失败/);
  assert.match(text, /没人在跟你说话/);
  // the constants (paths, waiting.json instructions) are the system prompt's job now
  assert.doesNotMatch(text, /waiting\.json/);
});

test("its own words are pasted verbatim, labelled, just before the reason it is awake", () => {
  const { input } = fixture();
  const i = input({ identity: "# 我是谁\n我是 alice。" });
  const text = buildPacket(i);
  // labelled, or the page reads as one authored document and it mistakes its own words
  // for something the environment said
  assert.match(text, /你写下的自己（\/state\/identity\.md）：\n\n# 我是谁\n我是 alice。/);
  // and placed last: the last two things it reads are who it decided it is, and why it is
  // awake
  const at = text.indexOf("我是 alice。");
  assert.ok(at > text.indexOf("未闭合的事"), "identity 应该排在事实之后");
  assert.ok(at < text.indexOf("你可以什么都不做"));
});

test("one sentence says why it is awake and whether anyone is there", () => {
  const { input } = fixture();
  const knocked = buildPacket(
    input({
      reason: "knock",
      inbox: [{ id: "1", file: "1.json", text: "在吗", from: "telegram:@you", chat: 111 }],
    }),
  );
  assert.match(knocked, /有人敲门，所以你现在醒了，现在有人在跟你说话。/);
  // the permission is always true, so it stands alone and never varies with the reason
  assert.match(knocked, /你可以什么都不做，那不算失败。/);
  assert.doesNotMatch(knocked, /说句话回去/);

  const timed = buildPacket(input({ reason: "timer" }));
  assert.match(timed, /你是被自己定的闹钟叫醒的，现在没人在跟你说话。/);
});

test("an event in the inbox is counted as an event, not as somebody talking", () => {
  const { input } = fixture();
  const event = { id: "github-7-ci-red", file: "github-7-ci-red.json", text: "PR #7 ci 红了", from: "github" };
  const text = buildPacket(input({ reason: "knock", inbox: [event] }));
  // a red build is not a person: saying so would make it answer into an empty room
  assert.match(text, /1 件不是对话（feed 写的），也在 \/inbox\/。/);
  assert.match(text, /收件箱里进了事件（不是对话），所以你现在醒了。/);
  assert.doesNotMatch(text, /有人在跟你说话/);

  const both = buildPacket(
    input({
      reason: "knock",
      inbox: [{ id: "1", file: "1.json", text: "在吗", from: "telegram:@you", chat: 111 }, event],
    }),
  );
  // counted separately, or the page credits the machine's news to the person
  assert.match(both, /有人在跟你说话：1 条，在 \/inbox\/。/);
  assert.match(both, /1 件不是对话（feed 写的）/);
});

test("nudge admits it was woken by default rather than by an alarm", () => {
  const { input } = fixture();
  assert.match(buildPacket(input({ reason: "nudge" })), /没有留下下次什么时候醒/);
});

test("open loops are counted by file, and pointed at instead of pasted", () => {
  const { input, paths } = fixture();
  mkdirSync(paths.openLoops, { recursive: true });
  writeText(join(paths.openLoops, "弄清一个问题.md"), "查过两次");
  writeText(join(paths.openLoops, "第二件.md"), "随便什么形状都行");
  const text = buildPacket(input({}));
  assert.match(text, /未闭合的事：2 件，在 \/state\/open-loops\/。/);
  // the title is for the agent to dig out, not for the daemon to summarize
  assert.doesNotMatch(text, /弄清一个问题/);
});

test("it is told the last words of the conversation, and who said them", () => {
  const { input } = fixture();
  const mine = buildPacket(
    input({
      lastWords: { dir: "out", text: "先去看 cgroup。", at: "2026-03-02T08:50:00Z", who: "telegram:@you" },
      lastSaid: "ignored when a transcript exists",
    }),
  );
  assert.match(mine, /你最后跟 telegram:@you 说的是 10m前：「先去看 cgroup。」/);
  assert.doesNotMatch(mine, /ignored when a transcript exists/);

  const theirs = buildPacket(
    input({ lastWords: { dir: "in", text: "帮我看下 X", at: "2026-03-02T08:59:00Z", who: "telegram:@you" } }),
  );
  assert.match(theirs, /telegram:@you 在 1m前说了最后一句：「帮我看下 X」，你之后没说话。/);

  // no gateway at all: fall back to what the harness saw it say
  assert.match(buildPacket(input({ lastSaid: "没有 gateway 时这句在" })), /没有 gateway 时这句在/);
});

test("the previous waking is stated as counts, never as a story", () => {
  const { input } = fixture();
  const knocked = buildPacket(
    input({
      lastCycle: { at: "2026-03-02T08:59:00Z", wake: "knock", tools: 9, inbox: 1, talkedTo: ["telegram:@you"], touched: 0 },
    }),
  );
  assert.match(knocked, /上一轮：有人敲门，和 telegram:@you 说了话，写了 0 个文件。/);

  const worked = buildPacket(
    input({ lastCycle: { at: "2026-03-02T08:30:00Z", wake: "timer", tools: 9, inbox: 0, talkedTo: [], touched: 3 } }),
  );
  assert.match(worked, /上一轮：你自己的闹钟，写了 3 个文件。/);

  const many = buildPacket(
    input({
      lastCycle: { at: "2026-03-02T08:30:00Z", wake: "timer", tools: 6, inbox: 0, talkedTo: ["telegram:@a", "telegram:@b"], touched: 1 },
    }),
  );
  assert.match(many, /上一轮：你自己的闹钟，和 2 个人说了话，写了 1 个文件。/);

  assert.doesNotMatch(buildPacket(input({ lastCycle: null })), /上一轮：/);
});

test("an empty open-loops directory is stated plainly", () => {
  const { input, paths } = fixture();
  mkdirSync(paths.openLoops, { recursive: true });
  assert.match(buildPacket(input({})), /没有未闭合的事/);
});

test("a conversation carries how much was said and when it started", () => {
  const { input } = fixture();
  const text = buildPacket(
    input({
      thread: {
        who: "telegram:@you",
        chat: 123456789,
        total: 214,
        bytes: 43 * 1024,
        lines: [
          { dir: "in", text: "它在干嘛", at: "2026-02-27T09:00:00Z" },
          { dir: "out", text: "在看自己写的 status.sh", at: "2026-02-27T09:00:30Z" },
          { dir: "in", text: "那 sun.js 呢", at: "2026-03-02T08:59:00Z" },
        ],
      },
    }),
  );
  assert.match(text, /你和 telegram:@you 说过 214 句，下面是最新的 3 句/);
  assert.match(text, /对方：它在干嘛/);
  assert.match(text, /你：在看自己写的 status.sh/);
  assert.match(text, /全部在 \/people\/123456789\.jsonl（214 句，43 KB）。/);
  // no summary of the relationship, ever
  assert.doesNotMatch(text, /关系|关心|画像/);
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
    chat: n % 2 === 0 ? 111 : 222,
  }));
  mkdirSync(paths.openLoops, { recursive: true });
  for (let n = 0; n < 200; n++) writeText(join(paths.openLoops, `第 ${n} 件事.md`), "x");
  const text = buildPacket(input({ inbox: many, lowPending: 500 }));
  assert.ok(Buffer.byteLength(text, "utf8") < 2500, `page grew to ${Buffer.byteLength(text, "utf8")}`);
  assert.match(text, /有人在跟你说话：200 条（2 个人），在 \/inbox\/。/);
  assert.match(text, /未闭合的事：200 件/);
});

test("a mute is stated as state, and says plainly that it changes nothing", () => {
  const { input } = fixture();
  const text = buildPacket(input({ mutes: { "chat:-1001234": { until: "2026-03-02T09:00:00Z" } } }));
  assert.match(text, /你静音了 chat:-1001234（到 2026-03-02T09:00:00Z）/);
  assert.match(text, /不改变投递/);
  assert.doesNotMatch(buildPacket(input({ mutes: {} })), /静音/);
});

test("the page says who is still waiting", () => {
  const text = buildPacket(
    fixture().input({
      waiting: [
        { who: "群「g」", at: "2026-03-02T08:59:00Z" },
        { who: "telegram:@owner", at: "2026-03-02T08:00:00Z" },
      ],
    }),
  );
  assert.match(text, /还没回的：群「g」（1m前）、telegram:@owner（1\.0h前）。/);
});

test("files it asked to forget, and files the cap took, are stated as what happened", () => {
  const forgotten = buildPacket(fixture().input({ filesForgotten: 2 }));
  assert.match(forgotten, /按你说的删了 2 个文件。/);

  const pruned = buildPacket(
    fixture().input({ filesPruned: 3, filesOldestPrunedMs: Date.parse("2026-02-01T09:00:00Z") }),
  );
  assert.match(pruned, /地方不够了，清掉 3 个最老的（最老的一个 29 天前）。/);

  // near the cap it says how full, so "worth deleting something" is a decision it can weigh
  const full = buildPacket(
    fixture().input({ filesUsedBytes: 460 * 1024 * 1024, filesCapMb: 500 }),
  );
  assert.match(full, /\/files 里 460 MB，上限 500 MB。/);

  // and when nothing happened, the page says nothing at all
  const quiet = buildPacket(fixture().input({}));
  assert.doesNotMatch(quiet, /删了|清掉|上限/);
});

test("a window it opened is stated on the page, and vanishes when it has passed", () => {
  const f = fixture();
  const now = f.input({}).nowMs;
  const live = f.input({ attention: { chats: [-1001234567890], untilMs: now + 3_600_000 } });
  assert.match(buildPacket(live), /你在听：群「测试」 的全部消息，到 \d\d:\d\d \+08 为止。/);
  const expired = f.input({ attention: { chats: [-1001234567890], untilMs: now - 1000 } });
  assert.doesNotMatch(buildPacket(expired), /你在听/);
});

test("a line that answers another one says so, without a lookup", () => {
  const f = fixture();
  const text = buildPacket(
    f.input({
      reason: "knock",
      inbox: [{ id: "1", file: "x", at: "2026-03-02T09:00:00Z", text: "说的就是这句", from: "telegram:@you", chat: -100 }],
      thread: {
        who: "telegram:@you",
        chat: -100,
        total: 2,
        bytes: 200,
        lines: [
          { at: "2026-03-02T08:00:00Z", dir: "out", text: "原文在这" },
          {
            at: "2026-03-02T09:00:00Z",
            dir: "in",
            text: "说的就是这句",
            quote: { id: "-100-7", from: "telegram:@you", text: "原文在这" },
          },
        ],
      },
    }),
  );
  assert.match(text, /对方：说的就是这句（回：原文在这）/);
  assert.match(text, /你：原文在这\n/);
});

test("a round that died says which of the three ways, and what it was doing", () => {
  const f = fixture();
  const base = { at: "2026-03-02T08:30:00Z", waking: 7, reason: "knock" };

  const killed = buildPacket(
    f.input({
      cut: { ...base, kind: "timeout", capMinutes: 20, tools: ["bash md5sum v8.md", "say"], openMs: 12 * 60_000 },
    }),
  );
  assert.match(killed, /上一轮跑到 20 分钟的上限被杀了（第 7 次醒来，被消息叫醒）。/);
  assert.match(killed, /最后的动作：bash md5sum v8\.md、say，最后一个已经跑了 12m。/);

  const crashed = buildPacket(f.input({ cut: { ...base, kind: "crashed" } }));
  assert.match(crashed, /上一轮没过完就断了（第 7 次醒来，被消息叫醒）。/);
  assert.doesNotMatch(crashed, /上限|被重启打断/);

  const restarted = buildPacket(f.input({ cut: { ...base, kind: "interrupted" } }));
  assert.match(restarted, /上一轮是被重启打断的，不是出错（第 7 次醒来，被消息叫醒）。/);
  assert.doesNotMatch(restarted, /上限|没过完/);

  // no advice rides along: the page states, it does not tell it what to do
  for (const page of [killed, crashed, restarted]) {
    assert.doesNotMatch(page, /看一眼|停在哪\/|别忘了|注意|建议/);
  }
  // the unknown case must not invent facts
  const bare = buildPacket(f.input({ cut: { ...base, kind: "timeout", waking: 0, reason: "timer" } }));
  assert.match(bare, /^上一轮跑到时间上限被杀了。$/m);
});

test("nothing is said when the last round ended on its own", () => {
  const page = buildPacket(fixture().input({ cut: null }));
  assert.doesNotMatch(page, /上一轮跑到|上一轮没过完|被重启打断/);
});

test("mail is counted with its senders, and never pretends to have woken it", () => {
  const f = fixture();
  const text = buildPacket(
    f.input({
      mailPending: {
        count: 2,
        senders: ["someone@example.org", "other@example.net"],
        oldestMs: Date.parse("2026-02-27T09:00:00Z"),
      },
    }),
  );
  // 3 days before the page's clock, and both senders named once
  assert.match(text, /邮件：2 封没处理，最早一封 3 天前，来自 someone@example\.org、other@example\.net，在 \/mail\/。/);
  // mail is pull: it must not be dressed up as a conversation or as somebody waiting
  assert.doesNotMatch(text, /有人在跟你说话/);
  assert.doesNotMatch(text, /还没回的/);
  assert.doesNotMatch(text, /群里的/);
  assert.equal(buildPacket(f.input({})).includes("邮件"), false, "没有邮件时一个字都不提");
});
