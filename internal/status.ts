import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { knownPlaces } from "./gateway.ts";
import { listSessionFiles } from "./runner.ts";
import { makePaths, type Paths } from "./paths.ts";
import { loadPolicy } from "./policy.ts";
import { formatDuration, readWaiting } from "./schedule.ts";
import { readJson, readText } from "./state.ts";
import { readMeta, readWakes, DAY_MS } from "./meta.ts";
import { listSnapshots } from "./backup.ts";

export interface Spend {
  cycles: number;
  tokens: number;
  cost: number;
}

/**
 * Straight off the one-line-per-cycle log, so it needs no separate ledger and
 * cannot disagree with the timeline a human reads.
 */
export function spendSince(p: Paths, nowMs: number, windowMs = DAY_MS): Spend {
  const text = readText(p.daemonLog) ?? "";
  const total: Spend = { cycles: 0, tokens: 0, cost: 0 };
  for (const line of text.split("\n")) {
    const at = Date.parse(line.slice(0, 24));
    if (Number.isNaN(at) || nowMs - at > windowMs) continue;
    total.cycles++;
    const tokens = /tokens=(\d+)/.exec(line);
    const cost = /cost=([\d.]+)/.exec(line);
    if (tokens?.[1]) total.tokens += Number(tokens[1]);
    if (cost?.[1]) total.cost += Number(cost[1]);
  }
  return total;
}

function bytes(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

function countJson(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function statusLine(root: string, instance: string): string {
  const p = makePaths(root, instance);
  const meta = readMeta(p);
  const wait = readWaiting(p.waiting);
  const policy = loadPolicy(p.policy);
  const now = Date.now();
  const sinceLast = typeof meta.lastWakeMs === "number" ? formatDuration(now - meta.lastWakeMs) : "从未";
  const next = wait ? formatDuration(Math.max(0, wait.dueAtMs - now)) : "未设定";
  const pending = countJson(p.inbox);
  return `${instance.padEnd(12)} 上次=${sinceLast.padEnd(7)} 下次=${next.padEnd(7)} 收件=${String(pending).padEnd(3)} runner=${policy.runner}`;
}

export async function printStatus(root: string, instance: string): Promise<void> {
  const p = makePaths(root, instance);
  const policy = loadPolicy(p.policy);
  const now = Date.now();
  const meta = readMeta(p);
  const wakes = readWakes(p, now);
  const wait = readWaiting(p.waiting);

  const identity = readText(p.identity);
  const loops = readJson<unknown[]>(p.openLoops, []);
  const sessions = listSessionFiles(p.sessionDir);
  const sessionBytes = sessions.reduce((n, f) => n + (statSync(f).size || 0), 0);
  const logTail = (readText(p.daemonLog) ?? "").trim().split("\n").slice(-1)[0] ?? "（无）";
  const spend = spendSince(p, now);
  const snapshots = await listSnapshots(p);
  const latest = snapshots[snapshots.length - 1];

  const rows: string[] = [
    p.instance,
    `  runner      ${policy.runner}`,
    `  上次醒来    ${typeof meta.lastWakeMs === "number" ? formatDuration(now - meta.lastWakeMs) + " 前" : "从未"}`,
    `  第几次      ${meta.wakings ?? 0}（24 小时内 ${wakes.length} 次）`,
    `  下次醒来    ${wait ? formatDuration(Math.max(0, wait.dueAtMs - now)) + " 后" : "未设定"}${wait?.why ? "  ·  " + wait.why : ""}`,
    `  收件        ${countJson(p.inbox)} 条待处理`,
    ...(knownPlaces(p.root, instance).length > 0
      ? [
          `  说话到      ${(() => {
            const places = knownPlaces(p.root, instance);
            const home = places.find((x) => x.home);
            return `${home ? home.label : "（没定）"}${places.length > 1 ? `，另有 ${places.length - 1} 个地方` : ""}`;
          })()}`,
        ]
      : []),
    `  identity    ${identity ? bytes(Buffer.byteLength(identity, "utf8")) : "（未写）"}`,
    `  未闭合      ${Array.isArray(loops) ? loops.length : 0} 件`,
    `  session     ${sessions.length} 文件 / ${bytes(sessionBytes)}`,
    `  花费        ${spend.cycles} 轮 · ${spend.tokens} tokens · $${spend.cost.toFixed(4)}`,
    `  快照        ${
      latest
        ? `${snapshots.length} 张，最近 ${formatDuration(now - Date.parse(latest.time))} 前`
        : "没有（或 rustic 不可用）"
    }`,
    `  上次一轮    ${logTail}`,
  ];
  console.log(rows.join("\n"));
}

export function listInstances(root: string): string[] {
  try {
    return readdirSync(join(root, "data"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function hasWaiting(root: string, instance: string): boolean {
  return existsSync(makePaths(root, instance).waiting);
}
