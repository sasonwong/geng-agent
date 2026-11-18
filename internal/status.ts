import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { knownPlaces } from "./gateway.ts";
import { listSessionFiles } from "./command.ts";
import { makePaths, type Paths } from "./paths.ts";
import { formatDuration, readWaiting } from "./schedule.ts";
import { readText } from "./fs.ts";
import { countLoops } from "./packet.ts";
import { peekInbox } from "./inbox.ts";
import { readMeta, readWakes, DAY_MS } from "./meta.ts";
import { listSnapshots } from "./backup.ts";

export interface Spend {
  cycles: number;
  tokens: number;
  cost: number;
  /** logs that are there but not UTF-8, so the numbers above are too small */
  unreadable: string[];
}

/** A log that exists and cannot be read is not an empty log: "0 rounds" would be a lie. */
function logText(files: string[], unreadable: string[]): string {
  return files
    .map((file) => {
      const text = readText(file);
      if (text === null && existsSync(file)) unreadable.push(basename(file));
      return text ?? "";
    })
    .join("\n");
}

/**
 * Straight off the one-line-per-cycle log, so it needs no separate ledger and
 * cannot disagree with the timeline a human reads.
 */
export function spendSince(p: Paths, nowMs: number, windowMs = DAY_MS): Spend {
  // `appendLine` rotates at 20 000 lines: after a rotation yesterday's rounds are in
  // `daemon.log.1` and today's in `daemon.log`, and reading only the live one would report
  // a cheaper day than the one that happened. Older first, so the order is unchanged.
  const unreadable: string[] = [];
  const text = logText([`${p.daemonLog}.1`, p.daemonLog], unreadable);
  const total: Spend = { cycles: 0, tokens: 0, cost: 0, unreadable };
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

/** What is waiting, by the same reader the daemon knocks on: a file it cannot parse is not
 *  a message. Counting names made the two lines a person reads disagree. */
function pendingInbox(dir: string): number {
  return peekInbox(dir).length;
}

export function statusLine(root: string, instance: string): string {
  const p = makePaths(root, instance);
  const meta = readMeta(p);
  const wait = readWaiting(p.waiting);
  const now = Date.now();
  const sinceLast = typeof meta.lastWakeMs === "number" ? formatDuration(now - meta.lastWakeMs) : "从未";
  const next = wait ? formatDuration(Math.max(0, wait.dueAtMs - now)) : "未设定";
  const pending = pendingInbox(p.inbox);
  return `${instance.padEnd(12)} 上次=${sinceLast.padEnd(7)} 下次=${next.padEnd(7)} 收件=${String(pending).padEnd(3)}`;
}

export async function printStatus(root: string, instance: string): Promise<void> {
  const p = makePaths(root, instance);
  const now = Date.now();
  const meta = readMeta(p);
  const wakes = readWakes(p, now);
  const wait = readWaiting(p.waiting);

  const identity = readText(p.identity);
  // Same split as doctor and the wake packet: "not written" and "there with bad bytes"
  // are two problems, and only one of them is answered by writing the file.
  const identityText = identity
    ? bytes(Buffer.byteLength(identity, "utf8"))
    : existsSync(p.identity)
      ? "在，但字节不是 UTF-8"
      : "（未写）";
  const loops = countLoops(p);
  const sessions = listSessionFiles(p.sessionDir);
  // A session rotated or cleaned up between the listing and the stat counts as 0: one
  // vanished file must not take the whole status down.
  const sessionBytes = sessions.reduce((n, f) => {
    try {
      return n + (statSync(f).size || 0);
    } catch {
      return n;
    }
  }, 0);
  const spend = spendSince(p, now);
  // `||`, not `??`: a log that is not there, or is empty, gives `""` here, and an empty
  // line is exactly what "（无）" is for. `??` never fired, because `""` is not nullish.
  const lastLine = (readText(p.daemonLog) ?? "").trim().split("\n").slice(-1)[0] || "（无）";
  const logTail = spend.unreadable.includes(basename(p.daemonLog)) ? "（读不出）" : lastLine;
  const snapshots = await listSnapshots(p);
  const latest = snapshots.ok ? snapshots.snapshots[snapshots.snapshots.length - 1] : undefined;
  // one read, one answer: the list was fetched twice in the same expression
  const places = knownPlaces(p.root, instance);

  const rows: string[] = [
    p.instance,
    `  上次醒来    ${typeof meta.lastWakeMs === "number" ? formatDuration(now - meta.lastWakeMs) + " 前" : "从未"}`,
    `  第几次      ${meta.wakings ?? 0}（24 小时内 ${wakes.length} 次）`,
    `  下次醒来    ${wait ? formatDuration(Math.max(0, wait.dueAtMs - now)) + " 后" : "未设定"}${wait?.why ? "  ·  " + wait.why : ""}`,
    `  收件        ${pendingInbox(p.inbox)} 条待处理`,
    ...(places.length > 0
      ? [
          `  说话到      ${(() => {
            const home = places.find((x) => x.home);
            return `${home ? home.label : "（没定）"}${places.length > 1 ? `，另有 ${places.length - 1} 个地方` : ""}`;
          })()}`,
        ]
      : []),
    `  identity    ${identityText}`,
    `  未闭合      ${loops} 件`,
    `  session     ${sessions.length} 文件 / ${bytes(sessionBytes)}`,
    `  花费        ${spend.cycles} 轮 · ${spend.tokens} tokens · $${spend.cost.toFixed(4)}${spend.unreadable.length > 0 ? `（${spend.unreadable.join("、")} 读不出，这个数偏小）` : ""}`,
    `  快照        ${
      !snapshots.ok
        ? `读不出（${snapshots.detail ?? "?"}）`
        : latest === undefined
          ? "没有"
          : Number.isFinite(now - Date.parse(latest.time))
            ? `${snapshots.snapshots.length} 张，最近 ${formatDuration(now - Date.parse(latest.time))} 前`
            : // some rustic builds leave the time out, and Date.parse("") is NaN
              `快照时间读不出来（${snapshots.snapshots.length} 张）`
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
