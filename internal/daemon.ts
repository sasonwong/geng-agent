import { existsSync, readdirSync, renameSync } from "node:fs";
import { listSessionFiles, runCycle, sweepOrphans } from "./runner.ts";
import { takeInbox } from "./inbox.ts";
import { buildPacket, type WakeReason } from "./packet.ts";
import { makePaths, type Paths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { formatDuration, readWaiting, type WaitSpec } from "./schedule.ts";
import { repairTail } from "./session.ts";
import { appendLine, ensureDirs, readJson, writeJson, writeText } from "./state.ts";

const POLL_MS = 5_000;

export interface DaemonOptions {
  root: string;
  instance: string;
  once?: boolean;
  dry?: boolean;
  log?: (line: string) => void;
}

function requiredDirs(p: Paths): string[] {
  return [
    p.data,
    p.sessionDir,
    p.palimpsest,
    p.journal,
    p.workspace,
    p.usage,
    p.meta,
    p.inbox,
    p.inboxSeen,
    p.outbox,
    p.acks,
  ];
}

function readLastWake(p: Paths): number | null {
  const v = readJson<{ atMs?: number }>(p.meta + "/lastwake.json", {});
  return typeof v.atMs === "number" ? v.atMs : null;
}

/** Cheap existence check: one pending file means "someone knocked". */
function inboxPending(p: Paths): boolean {
  try {
    return readdirSync(p.inbox).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Wait until `dueAtMs`, but wake early if someone knocks. */
async function sleepUntil(dueAtMs: number, paths: Paths): Promise<'time' | 'knock'> {
  while (Date.now() < dueAtMs) {
    await sleep(Math.min(POLL_MS, dueAtMs - Date.now()));
    if (inboxPending(paths)) return "knock";
  }
  return "time";
}

function consumeWaiting(paths: Paths): WaitSpec | null {
  const spec = readWaiting(paths.waiting, Date.now());
  if (existsSync(paths.waiting)) {
    try {
      renameSync(paths.waiting, paths.waitingConsumed);
    } catch {
      // someone else consumed it; nothing to do
    }
  }
  return spec;
}

export async function runDaemon(o: DaemonOptions): Promise<void> {
  const paths = makePaths(o.root, o.instance);
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  ensureDirs(requiredDirs(paths));
  const policy: Policy = loadPolicy(paths.policy);

  if (policy.runner === "docker") {
    const swept = await sweepOrphans(paths.instance);
    if (swept > 0) log(`清扫了 ${swept} 个孤儿容器`);
  }
  for (const file of listSessionFiles(paths.sessionDir)) {
    const report = repairTail(file, true);
    if (report.repairedLines > 0) log(`修复 session 尾部：${file} 丢掉了 ${report.repairedLines} 行`);
  }

  const sessionId = `geng-${paths.instance}`;

  for (;;) {
    let reason: WakeReason;
    let wait: WaitSpec | null = null;

    if (o.once) {
      reason = inboxPending(paths) ? "knock" : "timer";
    } else {
      wait = readWaiting(paths.waiting, Date.now());
      const minWakeMs = policy.cycle.minWakeMinutes * 60_000;
      const dueAt = wait
        ? Math.max(wait.dueAtMs, Date.now() + minWakeMs)
        : Date.now() + policy.cycle.defaultWakeMinutes * 60_000;
      const outcome = await sleepUntil(dueAt, paths);
      reason = outcome === "knock" ? "knock" : wait ? "timer" : "nudge";
    }

    const consumed = o.once ? readWaiting(paths.waiting, Date.now()) : consumeWaiting(paths);
    if (reason === "nudge" && wait === null) {
      // no alarm was set last time: this is the symptom, record it
      log(`第 ${new Date().toISOString()} 轮：没有 waiting.json`);
    }

    const inbox = takeInbox(paths.inbox, paths.inboxSeen);
    if (inbox.length > 0) reason = "knock";

    const lastWakeMs = readLastWake(paths);
    const nowMs = Date.now();
    writeJson(`${paths.meta}/lastwake.json`, { atMs: nowMs });

    const packet = buildPacket({
      paths,
      nowMs,
      reason,
      waitWhy: consumed?.why ?? null,
      lastWakeMs,
      statePath: policy.runner === "docker" ? "/state" : paths.palimpsest,
      inbox,
      maxBytes: policy.packet.maxBytes,
    });

    if (o.dry) {
      process.stdout.write(packet + "\n");
      return;
    }

    const result = await runCycle({ paths, policy, prompt: packet, sessionId });

    const line = [
      new Date().toISOString(),
      `wake=${reason}`,
      `dur=${formatDuration(result.durationMs)}`,
      `code=${result.code ?? "null"}`,
      `timedout=${result.timedOut ? "yes" : "no"}`,
      `inbox=${inbox.length}`,
      `wait=${consumed ? "yes" : "no"}`,
      `out=${result.stdout.length}`,
    ].join(" ");
    appendLine(paths.daemonLog, line);
    log(line);

    if (result.stdout.trim() !== "") writeText(`${paths.data}/last-output.txt`, result.stdout);
    if (result.stderr.trim() !== "") {
      appendLine(`${paths.data}/last-stderr.log`, `${new Date().toISOString()} ${result.stderr.trim()}`);
    }
    if (o.once) return;
  }
}
