import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./state.ts";

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
  lastWakeMs?: number;
  wakings?: number;
  /** The last thing it said, so a fresh-context waking knows how it left things. */
  lastSaid?: string | null;
  env?: Env;
  /**
   * The session's running totals as of the last waking. pi reports them cumulatively for
   * the whole session, so a per-cycle number only exists as a difference from these.
   */
  spent?: { tokens?: number; cost?: number };
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * pi reports cost and tokens for the whole session, and the session is resumed every
 * waking — so what this cycle cost is the difference. A fresh session starts from zero,
 * which would read as negative: that is a new session, not a refund, so it is floored.
 */
export function spentThisCycle(
  before: { tokens?: number; cost?: number },
  cumulative: { tokens?: number | null; cost?: number | null } | null,
): { tokens: number; cost: number } | null {
  if (!cumulative || (cumulative.tokens == null && cumulative.cost == null)) return null;
  return {
    tokens: Math.max(0, (cumulative.tokens ?? 0) - (before.tokens ?? 0)),
    cost: Math.max(0, (cumulative.cost ?? 0) - (before.cost ?? 0)),
  };
}

export function readMeta(paths: Paths): Meta {
  return readJson<Meta>(join(paths.meta, "state.json"), {});
}

export function writeMeta(paths: Paths, meta: Meta): void {
  writeJson(join(paths.meta, "state.json"), meta);
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
