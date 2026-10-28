import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./state.ts";
import { STATE_SCHEMA } from "./schema.ts";
import type { KnockHold } from "./schedule.ts";

/**
 * Everything the daemon counts about itself. One reader, used by the daemon, by
 * status and by doctor: two readers is how "上次醒来" quietly goes stale.
 */
/** What the waking was run with, so a change of environment can be stated as fact. */
export interface Env {
  imageId?: string | null;
  version?: string | null;
  /** Whether the search tool exists for this container, which the env file decides. */
  search?: boolean;
}

export interface Meta {
  /** Stamped by writeMeta: the shape the code expects to read back. */
  stateSchema?: number;
  lastWakeMs?: number;
  wakings?: number;
  /** The last thing it said, so a fresh-context waking knows how it left things. */
  lastSaid?: string | null;
  /** What the previous waking turned out to be, in counts and reasons only. */
  lastCycle?: {
    at: string;
    wake: "timer" | "knock" | "nudge";
    tools: number;
    inbox: number;
    /** Everybody it exchanged words with during that cycle, by their own name. */
    talkedTo: string[];
    /** Files written during that cycle, in /work and /state together. */
    touched: number;
  };
  env?: Env;
  /** Messages already delivered once; they may not knock again before this time. */
  knockHold?: KnockHold | null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How the round before this one ended, when it did not end on its own.
 *
 * One record for all three kinds: a third and fourth boolean on the page would be one
 * field per kind of death, and each would need its own reader. This is written by the
 * daemon, read once by the next page, and cleared — a note about a round, not a log.
 */
export interface CutRecord {
  kind: "timeout" | "crashed" | "interrupted";
  at: string;
  /** Which waking was cut and what woke it: both were already in intent.json. */
  waking: number;
  reason: string;
  /** The last few actions, known only when the daemon outlived the round (a timeout). */
  tools?: string[];
  /** How long the still-running action had been going when the round was killed. */
  openMs?: number;
  /** The cap that was in force then, not the one in force when the note is read. */
  capMinutes?: number;
}

export function readMeta(paths: Paths): Meta {
  return readJson<Meta>(join(paths.meta, "state.json"), {});
}

export function writeMeta(paths: Paths, meta: Meta): void {
  // stamped here rather than at every call site, so the file can never lack it
  writeJson(join(paths.meta, "state.json"), { ...meta, stateSchema: STATE_SCHEMA });
}

export function readWakes(paths: Paths, nowMs: number): number[] {
  return readJson<number[]>(
    join(paths.meta, "wakes.json"),
    [],
  ).filter((t) => nowMs - t < DAY_MS);
}

/**
 * Forgiving on purpose: a broken note is worth less than a waking that cannot start.
 *
 * Every field the page reads is checked here, not at the page: `/state` is writable from
 * inside, so a hand-written record is an ordinary input, and `tools: "bash ls"` used to
 * pass this check and then throw on `.join` while a waking was being assembled.
 */
export function readCut(paths: Paths): CutRecord | null {
  const rec = readJson<Partial<CutRecord> | null>(join(paths.meta, "cut.json"), null);
  if (rec === null || typeof rec !== "object") return null;
  if (rec.kind !== "timeout" && rec.kind !== "crashed" && rec.kind !== "interrupted") return null;
  const tools = Array.isArray(rec.tools) ? rec.tools.filter((t) => typeof t === "string") : [];
  const cap = typeof rec.capMinutes === "number" ? rec.capMinutes : undefined;
  const open = typeof rec.openMs === "number" ? rec.openMs : undefined;
  return {
    kind: rec.kind,
    at: typeof rec.at === "string" ? rec.at : "",
    waking: typeof rec.waking === "number" ? rec.waking : 0,
    reason: typeof rec.reason === "string" ? rec.reason : "timer",
    ...(tools.length === 0 ? {} : { tools }),
    ...(cap === undefined ? {} : { capMinutes: cap }),
    ...(open === undefined ? {} : { openMs: open }),
  };
}

export function writeCut(paths: Paths, rec: CutRecord): void {
  writeJson(join(paths.meta, "cut.json"), rec);
}

export function clearCut(paths: Paths): void {
  rmSync(join(paths.meta, "cut.json"), { force: true });
}

/** Record this waking and return how many there were in the last 24 hours. */
export function recordWake(paths: Paths, nowMs: number): number {
  const all = readWakes(paths, nowMs);
  all.push(nowMs);
  writeJson(join(paths.meta, "wakes.json"), all);
  return all.length;
}
