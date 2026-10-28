import { statSync } from "node:fs";
import { readJson } from "./state.ts";

export interface WaitSpec {
  dueAtMs: number;
  why: string | null;
}

interface RawWaiting {
  wake?: { after?: string | number; at?: string };
  why?: unknown;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseAfter(v: string | number): number | null {
  if (typeof v === "number") return v * 60_000;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2] as string];
  return unit ? n * unit : null;
}

/**
 * Returns null when waiting.json is absent or unparseable — the daemon treats that
 * as "no alarm set".
 *
 * A relative alarm ("in 30 minutes") is anchored to when the file was *written*,
 * not to when the daemon happens to read it: otherwise every restart postpones the
 * waking, and an alarm that came due while the machine was off never fires at all.
 */
export function readWaiting(file: string): WaitSpec | null {
  const raw = readJson<RawWaiting | null>(file, null);
  if (!raw || typeof raw !== "object") return null;
  const why = typeof raw.why === "string" ? raw.why : null;
  const wake = raw.wake;
  if (!wake || typeof wake !== "object") return null;

  if (typeof wake.at === "string") {
    const t = Date.parse(wake.at);
    if (Number.isNaN(t)) return null;
    return { dueAtMs: t, why };
  }
  if (wake.after !== undefined) {
    const delta = parseAfter(wake.after);
    if (delta === null) return null;
    let writtenAt: number;
    try {
      writtenAt = statSync(file).mtimeMs;
    } catch {
      return null;
    }
    return { dueAtMs: writtenAt + delta, why };
  }
  return null;
}

/**
 * An alarm is spent when the waking happened at or after the moment it asked for.
 *
 * A knock that arrives earlier is a waking that replaced the sleep, not one that
 * answered it: if this waking dies before writing a new alarm, the old one is still
 * the last thing it said about when to come back. Consuming it on any wake meant a
 * message arriving fifty seconds after "wake me in twenty minutes" quietly deleted it.
 *
 * For a timer wake the alarm is still renamed out of the way, and that rename has to
 * stay: it is not a record (nothing reads waiting.consumed.json), it is what stops a
 * past-due alarm from pinning `dueAt`. With the file still present every iteration
 * computes `max(dueAtMs, now + minWakeMinutes)` — one minute later — so a forgotten
 * alarm would wake the daemon every minute forever. The file's absence is the switch
 * that hands the wait back to defaultWakeMinutes.
 */
export function alarmSpent(wait: WaitSpec | null, nowMs: number): boolean {
  return wait !== null && nowMs >= wait.dueAtMs;
}

/**
 * Messages already handed over, and the earliest moment they may knock again.
 *
 * A waking that dies before it reads the inbox leaves the message on disk on purpose:
 * losing what a person said is worse than reading it twice. But a message that never
 * gets through (an empty cycle, a timeout) then knocked again seconds later, and again
 * — dozens of wakings an hour, each handing the same words to a model that had already
 * failed to answer them. The floor is per message, not per inbox: anything that arrived
 * since still knocks at once.
 */
export interface KnockHold {
  files: string[];
  untilMs: number;
}

/**
 * How long a message that has already been handed over must wait before it may knock again.
 *
 * After a round that ended cleanly, a minute is enough: the words were read, and the only
 * thing a shorter floor would buy is a second delivery of the same sentence. After a round
 * that did not, the same batch waits what a timer would wait at this escalation level —
 * otherwise a message nobody can answer keeps waking it forever, because the message only
 * counts as read when a round ends cleanly. New messages are unaffected either way.
 */
export function knockFloorMs(clean: boolean, minMs: number, backoffMs: number): number {
  return clean ? minMs : Math.max(minMs, backoffMs);
}

export function knockable(pending: string[], hold: KnockHold | null, nowMs: number): boolean {
  if (pending.length === 0) return false;
  if (!hold || nowMs >= hold.untilMs) return true;
  return pending.some((f) => !hold.files.includes(f));
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
