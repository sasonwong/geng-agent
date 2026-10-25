import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
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

/** Write via tmp + rename so a crash never leaves a half file. */
export function writeText(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, JSON.stringify(value, null, 2) + "\n");
}

export function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line + "\n", "utf8");
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

/** Last n non-empty lines, for showing the agent its own mechanical history. */
export function readTail(file: string, n: number): string[] {
  const text = readText(file);
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

export function excerpt(text: string | null, maxChars: number): string {
  if (!text) return "";
  const t = text.trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars) + "\n…(截断)";
}
