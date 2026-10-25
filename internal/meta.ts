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
  sessionGen?: number;
  env?: Env;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

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
