import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Files people sent it. Two ways out: it asks for specific ones to be forgotten, and the
 * size cap takes the oldest. Neither happens while it is running — a file disappearing
 * from under a read is the one failure this must not have.
 */
export interface FilesPolicy {
  /** 0 turns the age rule off; the size cap then governs alone. */
  maxAgeDays: number;
  maxMb: number;
}

export interface Usage {
  count: number;
  bytes: number;
  oldestMs: number | null;
}

export function filesUsage(dir: string): Usage {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    return { count: 0, bytes: 0, oldestMs: null };
  }
  let bytes = 0;
  let oldestMs: number | null = null;
  for (const name of names) {
    try {
      const s = statSync(join(dir, name));
      if (!s.isFile()) continue;
      bytes += s.size;
      if (oldestMs === null || s.mtimeMs < oldestMs) oldestMs = s.mtimeMs;
    } catch {
      // a file that vanished is not an error
    }
  }
  return { count: names.length, bytes, oldestMs };
}

/** A path it named: only ever a bare name inside the directory, never a way out. */
export function bareName(given: string): string | null {
  const trimmed = given.trim().replace(/^\/files\//, "");
  if (trimmed === "" || trimmed.includes("/") || trimmed.includes("..")) return null;
  return trimmed;
}

export interface PruneResult {
  removed: number;
  /** Age of the oldest thing removed, so the page can say how old it was. */
  oldestRemovedMs: number | null;
}

/**
 * Oldest first, until both limits hold. The newest are never touched: they are what this
 * waking might want to look at. `dry` counts what a real call would take without taking
 * it: a preview must say the same thing a start would say, over the same directory.
 */
export function pruneFiles(dir: string, policy: FilesPolicy, nowMs: number, dry = false): PruneResult {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    return { removed: 0, oldestRemovedMs: null };
  }
  const entries = names
    .map((name) => {
      try {
        const s = statSync(join(dir, name));
        return s.isFile() ? { name, size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((e): e is { name: string; size: number; mtimeMs: number } => e !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const capBytes = policy.maxMb * 1024 * 1024;
  const ageMs = policy.maxAgeDays > 0 ? policy.maxAgeDays * 24 * 60 * 60 * 1000 : null;
  let total = entries.reduce((sum, e) => sum + e.size, 0);

  let removed = 0;
  let oldestRemovedMs: number | null = null;
  // leave the newest file even if it alone is over the cap: deleting the thing that just
  // arrived would be the daemon judging what is worth keeping
  for (const e of entries.slice(0, -1)) {
    const tooOld = ageMs !== null && nowMs - e.mtimeMs > ageMs;
    if (!tooOld && total <= capBytes) break;
    if (!dry) {
      try {
        rmSync(join(dir, e.name), { force: true });
      } catch {
        // a file that would not go is retried next waking
        continue;
      }
    }
    total -= e.size;
    removed += 1;
    oldestRemovedMs ??= e.mtimeMs;
  }
  return { removed, oldestRemovedMs };
}

/**
 * What it asked to forget. Applied here rather than inside the container, because the
 * container never has the directory: it holds ids, so erasing what a person sent is a
 * request the host carries out, on its own clock, in the ledger of the round.
 */
export function forgetFiles(dir: string, requested: string[], dry = false): number {
  let removed = 0;
  for (const given of requested) {
    const name = bareName(given);
    if (name === null) continue;
    // Counted only when it was there. `rmSync(force)` does not throw on a missing file, so
    // a name that matched nothing used to be counted as a removal — the page then said
    // "按你说的删了 3 个文件" over a directory it had emptied one file from.
    if (!existsSync(join(dir, name))) continue;
    if (!dry) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // a file that would not go is retried next waking
        continue;
      }
    }
    removed += 1;
  }
  return removed;
}

export function parseForget(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const files = (raw as { files?: unknown }).files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}
