import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLedger,
  digestLedger,
  formatLedgerDigest,
  LEDGER_SCHEMA,
  parseSince,
  readLedger,
  roundSpeech,
  type LedgerRecord,
} from "../internal/ledger.ts";
import { makePaths } from "../internal/paths.ts";
import { readText, writeText } from "../internal/fs.ts";

function rec(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    v: LEDGER_SCHEMA,
    wake: 1,
    at: "2026-03-02T06:00:00.000Z",
    durMs: 1_200,
    reason: "timer",
    sym: "ok",
    lvl: 0,
    tools: 1,
    inj: 0,
    net: 0,
    talkedTo: [],
    said: 0,
    saidTo: [],
    touched: 0,
    ...over,
  };
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("账本：只追加，不重写已有的行；字段集合是约定", () => {
  withRoot((root) => {
    const p = makePaths(root, "alice");
    appendLedger(p, rec({ wake: 1 }));
    const first = readText(p.ledger) ?? "";
    appendLedger(p, rec({ wake: 2, at: "2026-03-02T07:00:00.000Z" }));
    // 第二行只能长在后面：重写一次就等于这本账不再能当证据
    assert.ok((readText(p.ledger) ?? "").startsWith(first));
    assert.equal(readLedger(p).map((r) => r.wake).join(","), "1,2");

    // 甲类接口：字段是定死的，加一个字段要有意为之
    const keys = [
      "at",
      "durMs",
      "inj",
      "lvl",
      "net",
      "reason",
      "said",
      "saidTo",
      "sym",
      "talkedTo",
      "touched",
      "tools",
      "v",
      "wake",
    ];
    assert.deepEqual(Object.keys(readLedger(p)[0] ?? {}).sort(), keys.sort());
    // 钱不在这本账里：tokens/cost 只在 daemon.log，spendSince 读那份
    assert.equal("cost" in (readLedger(p)[0] ?? {}), false);
    assert.equal("tokens" in (readLedger(p)[0] ?? {}), false);
  });
});

test("账本：轮转之后两份都读，旧的在前面", () => {
  withRoot((root) => {
    const p = makePaths(root, "alice");
    // appendLine 在 20 000 行时把活的文件改名成 .1；只读活的会少一段历史，
    // 这正是 spendSince 为 daemon.log 修过的那个洞。
    writeText(`${p.ledger}.1`, JSON.stringify(rec({ wake: 1 })) + "\n");
    appendLedger(p, rec({ wake: 2, at: "2026-03-02T07:00:00.000Z" }));
    assert.equal(readLedger(p).map((r) => r.wake).join(","), "1,2");
  });
});

test("账本：坏行跳过，不赔掉整本账", () => {
  withRoot((root) => {
    const p = makePaths(root, "alice");
    const lines = [
      JSON.stringify(rec({ wake: 1 })),
      '{"v":1,"wake":2', // 写到一半断电
      '"not an object"',
      // 只把类型写错：其余字段都齐全，所以拒它的只能是类型检查本身
      JSON.stringify({ ...rec({ wake: 3 }), wake: "3" }),
      JSON.stringify({ ...rec({ wake: 4 }), v: 99 }), // 新版本写的：跳过，不猜
      JSON.stringify(rec({ wake: 5, at: "2026-03-02T07:00:00.000Z" })),
    ];
    writeText(p.ledger, lines.join("\n") + "\n");
    assert.equal(readLedger(p).map((r) => r.wake).join(","), "1,5");
  });
});

test("账本：说过的话只被取走一次，下一轮不会接着数", () => {
  // 报 `note` 的那个 socket 比一轮活得久：取数如果不清，下一行就会带上上一轮的话。
  const s = roundSpeech((chat) => `chat ${chat}`);
  s.note(-1001234567890);
  s.note(-1001234567890);
  assert.deepEqual(s.take(), { said: 2, saidTo: ["chat -1001234567890"] });
  // 第二个读者拿到的是空的：这是「这一轮的」计数，不是累计
  assert.deepEqual(s.take(), { said: 0, saidTo: [] });
});

test("账本：「没人叫它」和「它动了」是两个数，合起来才是主动性", () => {
  const records = [
    rec({ wake: 1, reason: "knock", touched: 5 }), // 被叫醒，也写了东西
    rec({ wake: 2, reason: "timer", touched: 3 }), // 自己醒的，写了东西
    rec({ wake: 3, reason: "timer", touched: 0 }), // 自己醒的，什么也没做
    rec({ wake: 4, reason: "nudge", said: 1, saidTo: ["@someone"] }), // 兜底叫醒，它说了话
    rec({ wake: 5, reason: "knock", sym: "timeout", lvl: 2 }), // 被叫醒，超时
    // 只有人来说了一句、它一声没吭：这不是它做的事。两条，因为一条时「把入站算进去」
    // 恰好会和别的轮次抵平，总数看起来仍然对——这正是这类计数最容易骗过测试的地方。
    rec({ wake: 6, reason: "timer", talkedTo: ["@someone"] }),
    rec({ wake: 7, reason: "nudge", talkedTo: ["@someone"] }),
  ];
  const d = digestLedger(records);
  assert.equal(d.cycles, 7);
  assert.deepEqual(d.byWake, { timer: 3, knock: 2, nudge: 2 });
  assert.equal(d.unprompted, 5); // 不是被敲门叫醒的五轮
  assert.equal(d.unpromptedActed, 2); // 其中真的留下东西的两轮（#2 写文件、#4 说话）
  assert.equal(d.acted, 3); // 全部轮次里动过的（含被人叫醒的 #1）
  assert.equal(d.touched, 8);
  assert.equal(d.spoke, 1); // 出声的只有 #4
  assert.deepEqual(d.saidTo, ["@someone"]);
  assert.deepEqual(d.talkedTo, ["@someone"]);
  assert.equal(d.notOk, 1);
  assert.equal(d.worstLvl, 2);
});

test("账本：说了话算动了，哪怕那一下认不出是谁", () => {
  // 队列写成功但没有可命名的 place（还没人跟它说过话）：仍是它做的事。数的是这一轮
  // 自己排进队列的 `/say`，不是 gateway 两秒后投递出去的那条出站记录。
  const records = [
    rec({ wake: 1, reason: "timer", said: 1 }), // 说了，但 saidTo 空
    rec({ wake: 2, reason: "timer", talkedTo: ["@someone"] }), // 只有人来了一句
  ];
  const d = digestLedger(records);
  assert.equal(d.acted, 1);
  assert.equal(d.unpromptedActed, 1);
  assert.equal(d.spoke, 1);
  assert.deepEqual(d.saidTo, []);
});

test("账本：--since 的写法要有下界，不能把「7」猜成七天", () => {
  const now = Date.parse("2026-03-02T12:00:00Z");
  assert.equal(parseSince("24h", now), now - 86_400_000);
  assert.equal(parseSince("7d", now), now - 7 * 86_400_000);
  assert.equal(parseSince("30m", now), now - 30 * 60_000);
  assert.equal(parseSince("ALL", now), undefined);
  assert.equal(parseSince("2026-03-02T06:00:00Z", now), Date.parse("2026-03-02T06:00:00Z"));
  // 裸日期是当地零点：Date.parse("2026-03-02") 是 UTC 零点，+08 会多跳掉 8 小时
  const day = parseSince("2026-03-02", now);
  assert.ok(day !== undefined);
  assert.equal(new Date(day).getHours(), 0);
  assert.throws(() => parseSince("7", now));
});

test("账本：窗口和条数只影响读，不影响写", () => {
  withRoot((root) => {
    const p = makePaths(root, "alice");
    appendLedger(p, rec({ wake: 1, at: "2026-03-02T06:00:00.000Z" }));
    appendLedger(p, rec({ wake: 2, at: "2026-03-02T11:00:00.000Z" }));
    const since = Date.parse("2026-03-02T10:00:00Z");
    assert.equal(readLedger(p, { sinceMs: since }).map((r) => r.wake).join(","), "2");
    assert.equal(readLedger(p, { limit: 1 }).map((r) => r.wake).join(","), "2");
    // 读不删、不搬：原文件两行都还在
    assert.equal((readText(p.ledger) ?? "").trim().split("\n").length, 2);
  });
});

test("账本：给人看的那几行说清数和窗口，且不出现钱", () => {
  const records = [
    rec({ wake: 1, reason: "knock", touched: 2 }),
    rec({ wake: 2, reason: "timer", said: 1, saidTo: ["@someone"], lvl: 1 }),
  ];
  const text = formatLedgerDigest("alice", records, "最近 24h").join("\n");
  assert.match(text, /alice\s+账本：最近 24h · 2 轮/);
  assert.match(text, /醒来\s+1 定时 · 1 敲门 · 0 兜底/);
  assert.match(text, /自己动的\s+1 \/ 1 轮/);
  assert.match(text, /说过话\s+1 轮 · 1 个人/);
  assert.match(text, /最高档\s+第 1 档/);
  // 「钱」不在这本账里：一个数字出现两个地方，就会在两个地方对不上
  assert.doesNotMatch(text, /\$|cost|tokens/);
});
