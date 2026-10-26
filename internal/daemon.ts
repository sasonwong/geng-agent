import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, listSessionFiles, sweepOrphans } from "./command.ts";
import { markSeen, peekInbox } from "./inbox.ts";
import { deliveredFiles, freshForSteer, INJECT_CAP, injectionText } from "./inject.ts";
import { buildPacket, type WakeReason } from "./packet.ts";
import { makePaths, requiredDirs, type Paths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { ExpectedError } from "./errors.ts";
import { ensurePolicyLocation, onDiskSchema, schemaConflict, STATE_SCHEMA } from "./schema.ts";
import { filesUsage, forgetFiles, parseForget, pruneFiles } from "./files.ts";
import { formatDuration, readWaiting, type WaitSpec } from "./schedule.ts";
import { repairTail } from "./session.ts";
import { appendLine, ensureDirs, readJson, writeJson, writeText } from "./state.ts";
import { acquirePidLock } from "./guard.ts";
import { ensureGatewayDirs, readMutes, writeOps } from "./mute.ts";
import { DAY_MS, readMeta, recordWake, writeMeta, type Meta } from "./meta.ts";
import { maybeBackup, type BackupOutcome } from "./backup.ts";
import { applyProposal, policySummary } from "./proposal.ts";
import { activeSince, lastSaidIn, readSaid, waitingOn } from "./people.ts";
import { knownPlaces } from "./gateway.ts";
import { countTouched } from "./touch.ts";
import { systemPromptFor } from "./prompt.ts";
import { systemFacts } from "./packet.ts";
import { searchConfigured, searchQuota } from "./search.ts";
import { describeEnvChange, imageId, packageVersion } from "./env.ts";
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
  spent: { tokens: number; cost: number } | null,
  files: { pruned: number; forgot: number },
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
      `tokens=${spent ? spent.tokens : "-"}`,
      `cost=${spent ? spent.cost.toFixed(4) : "-"}`,
      `timedout=${r.timedOut ? "yes" : "no"}`,
      `ctx=${r.stats?.contextPercent != null ? `${r.stats.contextPercent}%` : "-"}`,
      `cache=${r.stats?.cacheRead ?? "-"}/${spent ? spent.tokens : "-"}`,
    );
  }
  parts.push(`inbox=${inboxCount}`);
  if (interventions.length > 0) parts.push(`fix=${interventions.join(",")}`);
  if (r && r.injections.length > 0) {
    const unread = r.injections.filter((i) => !i.read).length;
    parts.push(unread > 0 ? `inj=${r.injections.length}(unread=${unread})` : `inj=${r.injections.length}`);
  }
  if (files.pruned > 0) parts.push(`pruned=${files.pruned}`);
  if (files.forgot > 0) parts.push(`forgot=${files.forgot}`);
  if (backup) parts.push(`backup=${backup.status}${backup.detail ? `(${backup.detail})` : ""}`);
  return parts.join(" ");
}

export async function runDaemon(o: DaemonOptions): Promise<void> {
  const paths = makePaths(o.root, o.instance);
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  ensureDirs(requiredDirs(paths));
  ensurePolicyLocation(paths);
  const conflict = schemaConflict(onDiskSchema(paths));
  if (conflict !== null) throw new ExpectedError(conflict);
  // it is mounted read-only into the container, and docker materialises a missing
  // host path as a directory — after which appending a line is EISDIR forever
  if (!existsSync(paths.daemonLog)) writeText(paths.daemonLog, "");
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

  // Every waking starts a fresh container from the image tag, so a rebuilt image is
  // picked up by itself — but nothing would tell it that its world changed.
  const currentEnv = {
    imageId: await imageId(policy),
    version: packageVersion(paths.root),
    search: searchConfigured(paths.secrets),
  };
  const envChanged = describeEnvChange(readMeta(paths).env, currentEnv);

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
  // The three read-only auxiliaries sit at the top level, not under /state: a mount
  // nested inside the /state bind makes docker create its mountpoint through the bind,
  // which drops root-owned directories into the agent's own book.
  const at = (inContainer: string, host: string): string =>
    policy.runner === "docker" ? inContainer : host;
  const statePath = at("/state", paths.palimpsest);
  const longGapMs = Math.max(policy.cycle.defaultWakeMinutes * 60_000 * 3, LONG_GAP_FLOOR_MS);
  let crashed = o.dry ? existsSync(paths.intent) : recoverIntent(paths);
  if (crashed) writeOps(ops, `daemon@${paths.instance}`, "上一轮没过完就断了，已经记下，下一张纸会告诉它。");
  let escalation: Escalation = loadEscalation(paths);

  for (;;) {
    // Only while it is not running: a file vanishing under a read is the failure this
    // must not have. Its own requests go first, then the cap.
    const forgot = forgetFiles(
      paths.filesDir,
      parseForget(readJson<unknown>(paths.filesForget, null)),
    );
    rmSync(paths.filesForget, { force: true });
    const pruned = pruneFiles(paths.filesDir, policy.files, Date.now());
    const filesUsed = filesUsage(paths.filesDir);

    let meta = readMeta(paths);
    const waking = (meta.wakings ?? 0) + 1;
    const plan: Plan = planFor(escalation);
    let reason: WakeReason;
    let pendingWait: WaitSpec | null;

    if (o.once || o.dry) {
      reason = inboxPending(paths) ? "knock" : "timer";
      pendingWait = readWaiting(paths.waiting);
    } else {
      pendingWait = readWaiting(paths.waiting);
      const minWakeMs = policy.cycle.minWakeMinutes * 60_000;
      const backoffMs = policy.cycle.defaultWakeMinutes * 60_000 * plan.backoff;
      const firstWake = (meta.wakings ?? 0) === 0;
      const dueAt =
        // a life that has never woken has nothing to wait for: the first page is now
        firstWake && !pendingWait
          ? Date.now()
          : plan.backoff > 1
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

    // Read without consuming: the messages stay on disk (and inside the container's
    // read-only /state/inbox) until this wake has actually finished with them.
    const inbox = [...peekInbox(paths.inbox), ...peekInbox(paths.inboxLow)];
    if (inbox.length > 0) reason = "knock";

    const nowMs = Date.now();
    // The system prompt carries the two facts that only change when the operator does
    // something — where it may speak, and its own knobs — so the tools block underneath
    // it stays cacheable from one waking to the next.
    const systemPrompt = systemPromptFor(
      paths,
      systemFacts(knownPlaces(paths.root, o.instance), policySummary(policy)),
    );
    const longGap = typeof meta.lastWakeMs === "number" && nowMs - meta.lastWakeMs > longGapMs;
    const wakes24h = readJson<number[]>(join(paths.meta, "wakes.json"), []).filter(
      (t) => nowMs - t < DAY_MS,
    ).length;

    const packet = buildPacket({
      envChanged,
      paths,
      nowMs,
      reason,
      waitWhy: pendingWait?.why ?? null,
      lastWakeMs: typeof meta.lastWakeMs === "number" ? meta.lastWakeMs : null,
      waking,
      statePath,
      inboxPath: at("/inbox", paths.inbox),
      peoplePath: at("/people", paths.people),
      filesPath: at("/files", paths.filesDir),
      filesForgotten: forgot,
      filesPruned: pruned.removed,
      filesOldestPrunedMs: pruned.oldestRemovedMs,
      filesUsedBytes: filesUsed.bytes,
      filesCapMb: policy.files.maxMb,
      inbox,
      mutes: readMutes(paths.mute, nowMs),
      lastSaid: meta.lastSaid ?? null,
      lastCycle: meta.lastCycle ?? null,
      lastWords: (() => {
        const t = lastSaidIn(paths.data);
        const last = t?.tail[t.tail.length - 1];
        if (!t || !last) return null;
        return { dir: last.dir, text: last.text, at: last.at, who: t.who };
      })(),
      thread: (() => {
        const last = [...inbox].reverse().find((m) => typeof m.chat === "number");
        if (!last || last.chat === undefined) return null;
        const t = readSaid(paths.data, last.chat, 10);
        if (!t || t.tail.length === 0) return null;
        return {
          who: last.from ?? `chat ${last.chat}`,
          chat: last.chat,
          total: t.total,
          bytes: t.bytes,
          lines: t.tail,
        };
      })(),
      crashed,
      longGap,
      hint: plan.hint,
      lowPending: pendingLow(paths),
      wakes24h: wakes24h + 1,
      parked: plan.parked,

      searchLeft: searchQuota(paths.root, paths.secrets)?.left ?? null,
      waiting: waitingOn(paths.data),
    });

    if (o.dry) {
      process.stdout.write(`--- 系统提示词（常量 + identity）---\n${systemPrompt}\n`);
      process.stdout.write(`--- 唤醒纸（只有变量）---\n${packet}\n`);
      return;
    }

    // One waking, one session: nothing carries over in context, so nothing has to be
    // compacted either. The id is derived from the count, so a crashed waking that is
    // re-run continues the same file instead of starting a second one.
    const sessionId = `geng-${paths.instance}-${String(waking).padStart(4, "0")}`;

    writeJson(paths.intent, {
      startedAt: new Date(nowMs).toISOString(),
      waking,
      reason,
      level: escalation.level,
      sessionId,
      inboxIds: inbox.map((m) => m.id),
    });
    // spread the existing record: writing a literal here silently dropped `spent`
    meta = { ...meta, lastWakeMs: nowMs, wakings: waking, env: currentEnv };
    writeMeta(paths, meta);
    recordWake(paths, nowMs);

    const startedMs = Date.now();
    // the page already showed these; only what arrives from here on is pushed in
    const shown = new Set(inbox.map((m) => m.id));
    const injected: { id: string; file: string; text: string; from?: string }[] = [];
    const result = await runWaking({
      drain: () => {
        const fresh = freshForSteer(peekInbox(paths.inbox), shown, INJECT_CAP - injected.length);
        for (const m of fresh) {
          shown.add(m.id); // do not hand it the same words twice
          injected.push({ id: m.id, file: m.file, text: m.text, from: m.from });
        }
        return fresh.map(injectionText);
      },
      command: buildCommand(paths, policy, sessionId, systemPrompt),
      instance: paths.instance,
      isDocker: policy.runner === "docker",
      timeoutMs: policy.cycle.timeoutSec * 1000,
      prompt: packet,
      repeatThreshold: policy.cycle.repeatThreshold,
    });

    rmSync(paths.intent, { force: true });
    crashed = false;

    // Every waking is its own session, so the session total *is* this cycle's cost.
    // (It was a difference while one session spanned many wakings.)
    const stats = result.stats;
    const spent =
      stats && (stats.tokens != null || stats.cost != null)
        ? { tokens: stats.tokens ?? 0, cost: stats.cost ?? 0 }
        : null;
    if (stats) {
      meta = {
        ...meta,
        lastSaid: result.finalText.trim() === "" ? (meta.lastSaid ?? null) : result.finalText,
      };
      writeMeta(paths, meta);
    }

    const symptom = classify(result);
    // Only a wake that ran to the end has read them. Anything else leaves the messages
    // in place so the next wake hands them over again rather than losing them.
    // An injection that no turn followed never reached the model: leaving it unseen
    // means the next page hands it over again, which is the cheap side of the trade.
    const read = deliveredFiles(injected, result.injections);
    if (symptom === "ok" && inbox.length + read.length > 0) {
      markSeen(
        [paths.inbox, paths.inboxLow],
        paths.inboxSeen,
        [...inbox.map((m) => m.file), ...read],
      );
    }
    escalation = advance(escalation, symptom, result);
    saveEscalation(paths, escalation);

    meta = {
      ...meta,
      lastCycle: {
        at: new Date().toISOString(),
        wake: reason,
        tools: result.toolCalls.length,
        inbox: inbox.length,
        // not from the inbox: it can also speak first, and that is the same act.
        // A list, because a cycle can reach more than one person.
        talkedTo: activeSince(paths.data, startedMs).map((a) => a.who),
        // both halves: a cycle that only wrote a journal entry did something, and a
        // count that only watches /work would quietly teach it to touch files instead
        touched:
          countTouched(paths.workspace, startedMs) + countTouched(paths.palimpsest, startedMs),
      },
    };
    writeMeta(paths, meta);

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
      spent,
      { pruned: pruned.removed, forgot },
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
