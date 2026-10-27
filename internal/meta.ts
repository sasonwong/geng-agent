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

export function readMeta(paths: Paths): Meta {
  return readJson<Meta>(join(paths.meta, "state.json"), {});
}

export function writeMeta(paths: Paths, meta: Meta): void {
  // stamped here rather than at every call site, so the file can never lack it
  writeJson(join(paths.meta, "state.json"), { ...meta, stateSchema: STATE_SCHEMA });
}

export function readWakes(paths: Paths, nowMs: number): number[] {
  return readJson<number[]>(join(paths.meta, "wakes.json"), []).filter((t) => nowMs - t < DAY_MS);
}

/** Record this waking and return how many there were in the last 24 hours. */
export function recordWake(paths: Paths, nowMs: number): number {
  const all = readWakes(paths, nowMs);
  all.push(nowMs);
  writeJson(join(paths.meta, "wakes.json"), all);
  return all.length;
}
