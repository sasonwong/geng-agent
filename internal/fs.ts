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
export function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a");
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
