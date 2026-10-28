import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, listSessionFiles, sweepOrphans } from "./command.ts";
import { markSeen, peekInbox, quarantine } from "./inbox.ts";
import { deliveredFiles, freshForSteer, INJECT_CAP, injectionText, type LiveMsg } from "./inject.ts";
import { buildPacket, type WakeReason } from "./packet.ts";
import { makePaths, requiredDirs, type Paths } from "./paths.ts";
import { pendingMail } from "./mail.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { ExpectedError } from "./errors.ts";
import { ensurePolicyLocation, onDiskSchema, schemaConflict, STATE_SCHEMA } from "./schema.ts";
import { filesUsage, forgetFiles, parseForget, pruneFiles } from "./files.ts";
import {
  alarmSpent,
  formatDuration,
  knockable,
  knockFloorMs,
  readWaiting,
  type KnockHold,
  type WaitSpec,
} from "./schedule.ts";
import { repairTail } from "./session.ts";
import { appendLine, ensureDirs, readJson, readText, writeJson, writeText } from "./state.ts";
import { acquirePidLock } from "./guard.ts";
import { ensureGatewayDirs, readMutes, writeOps } from "./mute.ts";
import {
  clearCut,
  DAY_MS,
  readCut,
  readMeta,
  recordWake,
  writeCut,
  writeMeta,
  type CutRecord,
  type Meta,
} from "./meta.ts";
import { maybeBackup, type BackupOutcome } from "./backup.ts";
import { applyProposal, policySummary } from "./proposal.ts";
import { activeSince, lastSaidIn, readSaid, waitingOn } from "./people.ts";
import { knownPlaces } from "./gateway.ts";
import { parseAttention } from "./attention.ts";
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


function pendingFiles(p: Paths): string[] {
  // the parser, not a directory listing: a file nothing can read must not be able to knock
  return peekInbox(p.inbox).map((m) => m.file);
}

function inboxPending(p: Paths): boolean {
  return pendingFiles(p).length > 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

async function sleepUntil(dueAtMs: number, knock: () => boolean, parked: boolean): Promise<"time" | "knock"> {
  if (parked) {
    // only a knock can wake a parked instance; no timer
    for (;;) {
      await sleep(5_000);
      if (knock()) return "knock";
    }
  }
  while (Date.now() < dueAtMs) {
    await sleep(Math.min(POLL_MS, dueAtMs - Date.now()));
    if (knock()) return "knock";
  }
  return "time";
}

/**
 * The round before this daemon start, if it never finished.
 *
 * A leftover intent.json means the daemon itself was killed mid-round, so nothing about
 * the round's actions survived with it. A restart leaves one too, renamed aside so it is
 * not mistaken for a crash; older daemons also left `intent.aborted.*` files, which mean
 * the same thing. `consume` is what separates a preview from a start: the preview reads
 * the same note and deletes nothing.
 */
function leftoverCut(paths: Paths, consume: boolean): CutRecord | null {
  const intent = readJson<{ waking?: number; reason?: string } | null>(paths.intent, null);
  const interrupted = filesIn(paths.meta, "interrupted-");
  const legacy = filesIn(paths.meta, "intent.aborted.");

  const fromFile = (name: string | undefined): { waking: number; reason: string } => {
    const rec = name === undefined
      ? null
      : readJson<{ waking?: number; reason?: string } | null>(join(paths.meta, name), null);
    return { waking: numOr(rec?.waking, 0), reason: strOr(rec?.reason, "timer") };
  };

  let cut: CutRecord | null = null;
  if (intent !== null) {
    // the intent still in place is the newest thing we know about
    cut = { ...cutOf("crashed"), waking: numOr(intent.waking, 0), reason: strOr(intent.reason, "timer") };
  } else if (interrupted.length > 0) {
    cut = { ...cutOf("interrupted"), ...fromFile(interrupted[interrupted.length - 1]) };
  } else if (legacy.length > 0) {
    cut = { ...cutOf("crashed"), ...fromFile(legacy[legacy.length - 1]) };
  }

  if (consume) {
    rmSync(paths.intent, { force: true });
    for (const f of [...interrupted, ...legacy]) rmSync(join(paths.meta, f), { force: true });
  }
  return cut;
}

function filesIn(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function cutOf(kind: CutRecord["kind"]): CutRecord {
  return { kind, at: new Date().toISOString(), waking: 0, reason: "timer" };
}

const numOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const strOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

/** What a round killed at the wall left behind: where it was, and what it was doing. */
function cutOfTimeout(r: RpcResult, waking: number, reason: WakeReason, capMinutes: number): CutRecord {
  const recent = r.toolCalls.slice(-3).map((c) => `${c.name} ${c.preview}`.trim().slice(0, 80));
  const openMs = r.openCall ? Date.now() - r.openCall.atMs : undefined;
  return {
    ...cutOf("timeout"),
    waking,
    reason,
    capMinutes,
    ...(recent.length > 0 ? { tools: recent } : {}),
    ...(openMs === undefined ? {} : { openMs }),
  };
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
      // A restart is not a crash. Leaving intent.json behind makes the next start report
      // "上一轮没过完就断了" into ops and put a crash note on the page — one scary message
      // per deploy. It is put aside as interrupted instead, and no ops line is written.
      if (existsSync(paths.intent)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          renameSync(paths.intent, join(paths.meta, `interrupted-${stamp}.json`));
        } catch {
          // whatever happens, exiting is more important than tidying
        }
      }
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
  // A preview computes the same note without touching the disk: --dry must not eat what
  // it is showing, but it must still say what a real start would say.
  const leftover = leftoverCut(paths, !o.dry);
  if (leftover && !o.dry) {
    writeCut(paths, leftover);
    if (leftover.kind === "crashed") {
      writeOps(ops, `daemon@${paths.instance}`, "上一轮没过完就断了，已经记下，下一张纸会告诉它。");
    }
  }
  let escalation: Escalation = loadEscalation(paths);

  for (;;) {
    // Only while it is not running: a file vanishing under a read is the failure this
    // must not have. Its own requests go first, then the cap.
    const forgot = forgetFiles(
      paths.filesDir,
      parseForget(readJson<unknown>(paths.filesForget, null)),
    );
    rmSync(paths.filesForget, { force: true });
    // A message nothing can read is moved aside instead of being skipped forever. Before
    // this, one caption-less document knocked 58 times in an hour and handed over nothing.
    const junk = [
      ...quarantine(paths.inbox, paths.inboxSeen),
      ...quarantine(paths.inboxLow, paths.inboxSeen),
    ];
    if (junk.length > 0) log(`丢弃了 ${junk.length} 条读不出来的消息：${junk.join("、")}`);
    const pruned = pruneFiles(paths.filesDir, policy.files, Date.now());
    const filesUsed = filesUsage(paths.filesDir);

    let meta = readMeta(paths);
    const waking = (meta.wakings ?? 0) + 1;
    const plan: Plan = planFor(escalation);
    let reason: WakeReason;
    let pendingWait: WaitSpec | null;
    const minWakeMs = policy.cycle.minWakeMinutes * 60_000;

    if (o.once || o.dry) {
      reason = inboxPending(paths) ? "knock" : "timer";
      pendingWait = readWaiting(paths.waiting);
    } else {
      pendingWait = readWaiting(paths.waiting);
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
      const hold = (meta.knockHold ?? null) as KnockHold | null;
      const outcome = await sleepUntil(
        dueAt,
        () => knockable(pendingFiles(paths), hold, Date.now()),
        plan.parked,
      );
      reason = outcome === "knock" ? "knock" : pendingWait ? "timer" : "nudge";
    }

    // Only an alarm whose moment has arrived is spent here. A knock that came first does
    // not cancel it: if this waking dies before writing a new one, the alarm is still the
    // last thing it said about when to come back. (See alarmSpent.)
    if (alarmSpent(pendingWait, Date.now()) && existsSync(paths.waiting) && !o.dry) {
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
    const places = knownPlaces(paths.root, o.instance);
    const capMinutes = Math.max(1, Math.round(policy.cycle.timeoutSec / 60));
    const systemPrompt = systemPromptFor(
      paths,
      systemFacts(places, policySummary(policy), capMinutes),
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
      timezone: policy.timezone,
      places,
      attention: parseAttention(readJson(join(paths.palimpsest, "attention.json"), null)),
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
      cut: o.dry ? (leftover ?? readCut(paths)) : readCut(paths),
      longGap,
      hint: plan.hint,
      lowPending: pendingLow(paths),
      mailPending: pendingMail(paths),
      mailPath: at("/mail", paths.mail),
      wakes24h: wakes24h + 1,
      parked: plan.parked,

      searchLeft: searchQuota(paths.root, paths.secrets)?.left ?? null,
      waiting: waitingOn(paths.data),
      identity: readText(paths.identity),
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
    // the whole message, not a copy of the field list: a builder here would silently
    // drop any field added later (attachments was the one that went missing)
    const injected: LiveMsg[] = [];
    const result = await runWaking({
      drain: () => {
        const fresh = freshForSteer(peekInbox(paths.inbox), shown, INJECT_CAP - injected.length);
        for (const m of fresh) {
          shown.add(m.id); // do not hand it the same words twice
          injected.push(m); // InboxMsg is a structural superset of LiveMsg
        }
        return fresh.map(injectionText);
      },
      command: buildCommand(paths, policy, sessionId, systemPrompt, places.length),
      instance: paths.instance,
      isDocker: policy.runner === "docker",
      timeoutMs: policy.cycle.timeoutSec * 1000,
      prompt: packet,
      repeatThreshold: policy.cycle.repeatThreshold,
    });

    rmSync(paths.intent, { force: true });

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
    // The page just built already said how the last round ended, and this note is about
    // one round: clear it, then replace it only if this round was itself cut at the wall.
    clearCut(paths);
    if (symptom === "timeout") writeCut(paths, cutOfTimeout(result, waking, reason, capMinutes));
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

    // a message that has already been handed over gets a floor before it may knock
    // again; anything that arrives in the meantime does not wait behind it
    const handed = [...inbox.map((m) => m.file), ...read];
    // a clean round gets the minute; one that failed gets the backoff a timer would get, so
    // the same unanswerable message cannot wake it every minute for the rest of the night
    const rung = planFor(escalation);
    const holdMs = knockFloorMs(
      symptom === "ok",
      minWakeMs,
      policy.cycle.defaultWakeMinutes * 60_000 * rung.backoff,
      rung.parked,
    );
    meta = {
      ...meta,
      knockHold: handed.length === 0 ? null : { files: handed, untilMs: Date.now() + holdMs },
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
