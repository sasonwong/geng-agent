import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { abortRunning, listSessionFiles, runCycle, sweepOrphans } from "./runner.ts";
import { peekInbox, takeInbox } from "./inbox.ts";
import { buildPacket, type WakeReason } from "./packet.ts";
import { makePaths, type Paths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { formatDuration, readWaiting, type WaitSpec } from "./schedule.ts";
import { repairTail } from "./session.ts";
import { appendLine, ensureDirs, readJson, writeJson, writeText } from "./state.ts";
import { acquirePidLock } from "./guard.ts";

const POLL_MS = 5_000;
const LONG_GAP_FLOOR_MS = 3 * 3_600_000;

export interface DaemonOptions {
  root: string;
  instance: string;
  once?: boolean;
  dry?: boolean;
  log?: (line: string) => void;
}

interface StartState {
  lastWakeMs: number | null;
  waking: number;
  crashed: boolean;
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

function inboxPending(p: Paths): boolean {
  try {
    return readdirSync(p.inbox).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Wait until `dueAtMs`, but wake early if someone knocks. */
async function sleepUntil(dueAtMs: number, paths: Paths): Promise<"time" | "knock"> {
  while (Date.now() < dueAtMs) {
    await sleep(Math.min(POLL_MS, dueAtMs - Date.now()));
    if (inboxPending(paths)) return "knock";
  }
  return "time";
}

/**
 * A leftover intent.json means the previous waking never finished. Rename it out of
 * the way and report the fact once, so the next waking knows to look before working.
 */
function recoverIntent(paths: Paths): boolean {
  if (!existsSync(paths.intent)) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    renameSync(paths.intent, join(paths.meta, `intent.aborted.${stamp}.json`));
  } catch {
    rmSync(paths.intent, { force: true });
  }
  return true;
}

function readStart(paths: Paths): StartState {
  const meta = readJson<{ lastWakeMs?: number; wakings?: number }>(
    join(paths.meta, "state.json"),
    {},
  );
  return {
    lastWakeMs: typeof meta.lastWakeMs === "number" ? meta.lastWakeMs : null,
    waking: typeof meta.wakings === "number" ? meta.wakings : 0,
    crashed: false,
  };
}

export async function runDaemon(o: DaemonOptions): Promise<void> {
  const paths = makePaths(o.root, o.instance);
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  ensureDirs(requiredDirs(paths));
  const policy: Policy = loadPolicy(paths.policy);

  let releaseLock: (() => void) | null = null;
  if (!o.dry) {
    releaseLock = acquirePidLock(join(paths.data, "daemon.pid"));
    const onSignal = () => {
      abortRunning();
      releaseLock?.();
      process.exit(0);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  if (policy.runner === "docker") {
    const swept = await sweepOrphans(paths.instance);
    if (swept > 0) log(`清扫了 ${swept} 个孤儿容器`);
  }
  for (const file of listSessionFiles(paths.sessionDir)) {
    const report = repairTail(file, true);
    if (report.repairedLines > 0) log(`修复 session 尾部：${file} 丢掉了 ${report.repairedLines} 行`);
  }

  const sessionId = `geng-${paths.instance}`;
  const statePath = policy.runner === "docker" ? "/state" : paths.palimpsest;
  const workPath = policy.runner === "docker" ? "/work" : paths.workspace;
  // A dry run reports a leftover intent but must not move it: previews stay read-only.
  let crashed = o.dry ? existsSync(paths.intent) : recoverIntent(paths);
  const longGapMs = Math.max(policy.cycle.defaultWakeMinutes * 60_000 * 3, LONG_GAP_FLOOR_MS);

  for (;;) {
    const start = readStart(paths);
    let reason: WakeReason;
    let pendingWait: WaitSpec | null;

    if (o.once) {
      reason = inboxPending(paths) ? "knock" : "timer";
      pendingWait = readWaiting(paths.waiting, Date.now());
    } else {
      pendingWait = readWaiting(paths.waiting, Date.now());
      const minWakeMs = policy.cycle.minWakeMinutes * 60_000;
      const dueAt = pendingWait
        ? Math.max(pendingWait.dueAtMs, Date.now() + minWakeMs)
        : Date.now() + policy.cycle.defaultWakeMinutes * 60_000;
      const outcome = await sleepUntil(dueAt, paths);
      reason = outcome === "knock" ? "knock" : pendingWait ? "timer" : "nudge";
    }

    if (existsSync(paths.waiting) && !o.dry) {
      try {
        renameSync(paths.waiting, paths.waitingConsumed);
      } catch {
        // someone else consumed it
      }
    }

    const inbox = o.dry ? peekInbox(paths.inbox) : takeInbox(paths.inbox, paths.inboxSeen);
    if (inbox.length > 0) reason = "knock";

    const nowMs = Date.now();
    const waking = start.waking + 1;
    const longGap =
      start.lastWakeMs !== null && nowMs - start.lastWakeMs > longGapMs;

    const packet = buildPacket({
      paths,
      nowMs,
      reason,
      waitWhy: pendingWait?.why ?? null,
      lastWakeMs: start.lastWakeMs,
      waking,
      statePath,
      workPath,
      inbox,
      maxBytes: policy.packet.maxBytes,
      crashed,
      longGap,
    });

    if (o.dry) {
      process.stdout.write(packet + "\n");
      return;
    }

    writeJson(paths.intent, {
      startedAt: new Date(nowMs).toISOString(),
      waking,
      reason,
      inboxIds: inbox.map((m) => m.id),
      sessionId,
    });
    writeJson(join(paths.meta, "state.json"), { lastWakeMs: nowMs, wakings: waking });

    const result = await runCycle({ paths, policy, prompt: packet, sessionId });
    rmSync(paths.intent, { force: true });
    crashed = false;

    const line = [
      new Date().toISOString(),
      `#${waking}`,
      `wake=${reason}`,
      `dur=${formatDuration(result.durationMs)}`,
      `code=${result.code ?? "null"}`,
      `timedout=${result.timedOut ? "yes" : "no"}`,
      `inbox=${inbox.length}`,
      `out=${result.stdout.length}`,
    ].join(" ");
    appendLine(paths.daemonLog, line);
    log(line);

    if (result.stdout.trim() !== "") writeText(join(paths.data, "last-output.txt"), result.stdout);
    if (result.stderr.trim() !== "") {
      appendLine(
        join(paths.data, "last-stderr.log"),
        `${new Date().toISOString()} ${result.stderr.trim()}`,
      );
    }
    if (o.once) return;
  }
}
