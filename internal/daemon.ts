import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, listSessionFiles, sweepOrphans } from "./command.ts";
import { peekInbox, takeInbox } from "./inbox.ts";
import { buildPacket, type WakeReason } from "./packet.ts";
import { makePaths, type Paths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { formatDuration, readWaiting, type WaitSpec } from "./schedule.ts";
import { repairTail } from "./session.ts";
import { appendLine, ensureDirs, readJson, writeJson, writeText } from "./state.ts";
import { acquirePidLock } from "./guard.ts";
import { ensureGatewayDirs, writeOps } from "./mute.ts";
import { DAY_MS, readMeta, recordWake, writeMeta, type Meta } from "./meta.ts";
import { maybeBackup, type BackupOutcome } from "./backup.ts";
import { applyProposal, policySummary } from "./proposal.ts";
import { searchQuota } from "./search.ts";
import { abortActive, runWaking, type RpcResult } from "./rpc.ts";
import { classify, SYMPTOM_LABEL } from "./symptoms.ts";
import { advance, loadEscalation, planFor, saveEscalation, type Escalation, type Plan } from "./escalation.ts";

const POLL_MS = 5_000;
const LONG_GAP_FLOOR_MS = 3 * 3_600_000;

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
    p.inboxLow,
    p.outbox,
  ];
}

function pendingLow(p: Paths): number {
  try {
    return readdirSync(p.inboxLow).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function inboxPending(p: Paths): boolean {
  try {
    // only the top level counts as a knock; inbox/low is drained but never wakes
    return readdirSync(p.inbox).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

async function sleepUntil(dueAtMs: number, paths: Paths, parked: boolean): Promise<"time" | "knock"> {
  if (parked) {
    // only a knock can wake a parked instance; no timer
    for (;;) {
      await sleep(5_000);
      if (inboxPending(paths)) return "knock";
    }
  }
  while (Date.now() < dueAtMs) {
    await sleep(Math.min(POLL_MS, dueAtMs - Date.now()));
    if (inboxPending(paths)) return "knock";
  }
  return "time";
}

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

function logLine(
  waking: number,
  reason: WakeReason,
  r: RpcResult | null,
  symptom: string,
  level: number,
  inboxCount: number,
  interventions: string[],
  backup: BackupOutcome | null,
): string {
  const parts = [
    new Date().toISOString(),
    `#${waking}`,
    `wake=${reason}`,
    `sym=${symptom}`,
    `lvl=${level}`,
  ];
  if (r) {
    parts.push(
      `dur=${formatDuration(r.durationMs)}`,
      `tools=${r.toolCalls.length}`,
      `tokens=${r.stats?.tokens ?? "-"}`,
      `cost=${r.stats?.cost?.toFixed(4) ?? "-"}`,
      `timedout=${r.timedOut ? "yes" : "no"}`,
    );
  }
  parts.push(`inbox=${inboxCount}`);
  if (interventions.length > 0) parts.push(`fix=${interventions.join(",")}`);
  if (backup) parts.push(`backup=${backup.status}${backup.detail ? `(${backup.detail})` : ""}`);
  return parts.join(" ");
}

export async function runDaemon(o: DaemonOptions): Promise<void> {
  const paths = makePaths(o.root, o.instance);
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  ensureDirs(requiredDirs(paths));
  if (!o.dry) {
    const proposal = applyProposal(paths);
    if (proposal) {
      const lines = [
        ...proposal.applied.map((a) => `${a.key} ${String(a.from)} → ${a.to}`),
        ...proposal.rejected.map((r) => `${r.key} 没采用（${r.reason}）`),
      ];
      if (lines.length > 0) {
        writeOps(ensureGatewayDirs(paths.root).ops, `daemon@${paths.instance}`, `改了运行参数：${lines.join("；")}`);
      }
    }
  }
  let policy: Policy = loadPolicy(paths.policy);

  let releaseLock: (() => void) | null = null;
  if (!o.dry) {
    releaseLock = acquirePidLock(join(paths.data, "daemon.pid"));
    const onSignal = () => {
      abortActive();
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

  const { ops } = ensureGatewayDirs(paths.root);
  const statePath = policy.runner === "docker" ? "/state" : paths.palimpsest;
  const workPath = policy.runner === "docker" ? "/work" : paths.workspace;
  const longGapMs = Math.max(policy.cycle.defaultWakeMinutes * 60_000 * 3, LONG_GAP_FLOOR_MS);
  let crashed = o.dry ? existsSync(paths.intent) : recoverIntent(paths);
  if (crashed) writeOps(ops, `daemon@${paths.instance}`, "上一轮没过完就断了，已经记下，下一张纸会告诉它。");
  let escalation: Escalation = loadEscalation(paths);

  for (;;) {
    const meta = readMeta(paths);
    const waking = (meta.wakings ?? 0) + 1;
    const plan: Plan = planFor(escalation);
    let reason: WakeReason;
    let pendingWait: WaitSpec | null;

    if (o.once || o.dry) {
      reason = inboxPending(paths) ? "knock" : "timer";
      pendingWait = readWaiting(paths.waiting, Date.now());
    } else {
      pendingWait = readWaiting(paths.waiting, Date.now());
      const minWakeMs = policy.cycle.minWakeMinutes * 60_000;
      const backoffMs = policy.cycle.defaultWakeMinutes * 60_000 * plan.backoff;
      const dueAt =
        plan.backoff > 1
          ? Date.now() + backoffMs
          : pendingWait
            ? Math.max(pendingWait.dueAtMs, Date.now() + minWakeMs)
            : Date.now() + backoffMs;
      const outcome = await sleepUntil(dueAt, paths, plan.parked);
      reason = outcome === "knock" ? "knock" : pendingWait ? "timer" : "nudge";
    }

    if (existsSync(paths.waiting) && !o.dry) {
      try {
        renameSync(paths.waiting, paths.waitingConsumed);
      } catch {
        // someone else consumed it
      }
    }

    const inbox = o.dry ? peekInbox(paths.inbox) : takeInbox(paths.inbox, paths.inboxSeen, paths.inboxLow);
    if (inbox.length > 0) reason = "knock";

    const nowMs = Date.now();
    const longGap = typeof meta.lastWakeMs === "number" && nowMs - meta.lastWakeMs > longGapMs;
    const wakes24h = readJson<number[]>(join(paths.meta, "wakes.json"), []).filter(
      (t) => nowMs - t < DAY_MS,
    ).length;

    const packet = buildPacket({
      paths,
      nowMs,
      reason,
      waitWhy: pendingWait?.why ?? null,
      lastWakeMs: typeof meta.lastWakeMs === "number" ? meta.lastWakeMs : null,
      waking,
      statePath,
      workPath,
      inbox,
      maxBytes: policy.packet.maxBytes,
      crashed,
      longGap,
      hint: plan.hint,
      lowPending: pendingLow(paths),
      wakes24h: wakes24h + 1,
      parked: plan.parked,
      policyLine: policySummary(policy),
      searchLeft: searchQuota(paths.root)?.left ?? null,
    });

    if (o.dry) {
      process.stdout.write(packet + "\n");
      return;
    }

    const sessionGen = plan.newSession ? (meta.sessionGen ?? 0) + 1 : (meta.sessionGen ?? 0);
    const sessionId = sessionGen === 0 ? `geng-${paths.instance}` : `geng-${paths.instance}-${sessionGen}`;

    writeJson(paths.intent, {
      startedAt: new Date(nowMs).toISOString(),
      waking,
      reason,
      level: escalation.level,
      sessionId,
      inboxIds: inbox.map((m) => m.id),
    });
    writeJson(join(paths.meta, "state.json"), {
      lastWakeMs: nowMs,
      wakings: waking,
      sessionGen,
    });
    recordWake(paths, nowMs);

    const result = await runWaking({
      command: buildCommand(paths, policy, sessionId),
      instance: paths.instance,
      isDocker: policy.runner === "docker",
      timeoutMs: policy.cycle.timeoutSec * 1000,
      prompt: packet,
      repeatThreshold: policy.cycle.repeatThreshold,
    });

    rmSync(paths.intent, { force: true });
    crashed = false;

    const symptom = classify(result);
    escalation = advance(escalation, symptom, result);
    saveEscalation(paths, escalation);

    const backup = await maybeBackup({ paths, policy, nowMs: Date.now() });
    const line = logLine(
      waking,
      reason,
      result,
      symptom,
      escalation.level,
      inbox.length,
      result.interventions,
      backup,
    );
    appendLine(paths.daemonLog, line);
    log(line);

    if (result.finalText.trim() !== "") {
      writeText(join(paths.data, "last-output.txt"), result.finalText);
    }
    if (result.stderrTail.trim() !== "") {
      appendLine(join(paths.data, "last-stderr.log"), `${new Date().toISOString()} ${result.stderrTail.trim()}`);
    }
    if (symptom !== "ok") {
      appendLine(
        join(paths.usage, "symptoms.log"),
        `${new Date().toISOString()} ${symptom} lvl=${escalation.level} ${escalation.detail}`,
      );
    }
    if (escalation.level >= 5) {
      writeOps(
        ops,
        `daemon@${paths.instance}`,
        `连续 ${escalation.streak} 轮没有结果（${escalation.detail}），下一轮按第 ${escalation.level} 档处理。`,
      );
    }
    if (escalation.level >= 3) {
      log(`  → 下一轮按第 ${escalation.level} 档（${escalation.symptom ? SYMPTOM_LABEL[escalation.symptom] : "?"}，连续 ${escalation.streak} 次）`);
    }

    if (o.once) return;
  }
}
