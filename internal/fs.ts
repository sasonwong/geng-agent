import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  const text = readText(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write via tmp + rename so a crash never leaves a half file, and fsync before the
 * rename so a power cut cannot leave it empty. A few milliseconds per write is worth
 * it: everything the daemon records is what the next waking has to reconstruct from.
 */
export function writeText(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

/** Append + fsync: an append-only log that loses its tail is a log with a hole. */
/**
 * One previous copy, rotated by line count. These files only grow, and the two that grow
 * fastest are the ones nobody reads in full: `net.log` gets a line per connection and
 * `daemon.log` a line per round. Twenty thousand lines is roughly a year of rounds and a
 * few days of a busy network log — small enough to keep, large enough not to worry about.
 *
 * The count is per process, seeded by reading the file once. Two processes appending to
 * one file (the daemon and the gateway both write `ops.log`) can rotate a little early;
 * that is the only cost, and a log that loses its oldest lines is not a correctness bug.
 */
const LINES = new Map<string, number>();

export function appendLine(file: string, line: string, maxLines = 20_000): void {
  mkdirSync(dirname(file), { recursive: true });
  let seen = LINES.get(file);
  if (seen === undefined) {
    try {
      seen = readFileSync(file, "utf8").split("\n").length - 1;
    } catch {
      seen = 0;
    }
  }
  if (seen >= maxLines) {
    try {
      renameSync(file, `${file}.1`);
    } catch {
      // first write of a process on a file that is gone: nothing to rotate
    }
    seen = 0;
  }
  const fd = openSync(file, "a");
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  LINES.set(file, seen + 1);
}

export function ensureDirs(dirs: string[]): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}

export function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function exists(file: string): boolean {
  return existsSync(file);
}

export function excerpt(text: string | null, maxChars: number): string {
  if (!text) return "";
  const t = text.trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars) + "\n…(截断)";
}
