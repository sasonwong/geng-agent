import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLine } from "./state.ts";

/**
 * What was actually exchanged with one address, in order, forever. Append-only and
 * never summarised: anything resembling a profile of a person would be a judgement we
 * handed it, so the only thing kept here is what was literally said.
 */
export interface Said {
  at: string;
  dir: "in" | "out";
  text: string;
  from?: string;
  /** `<chat>-<message_id>`: what it needs to quote a line from an older exchange. */
  id?: string;
}

export function peopleDir(data: string): string {
  return join(data, "people");
}

export function saidFile(data: string, chat: number): string {
  return join(peopleDir(data), `${chat}.jsonl`);
}

export function appendSaid(data: string, chat: number, entry: Said): void {
  mkdirSync(peopleDir(data), { recursive: true });
  appendLine(saidFile(data, chat), JSON.stringify(entry));
}

/**
 * The most recent thing said with anybody, whoever started it. Used both for "who did
 * you last talk to" and for the page's last-words line, so a message it sent on its own
 * initiative counts the same as a reply.
 */
export function lastSaidIn(
  data: string,
  limit = 20,
): { chat: number; who: string; at: string; tail: Said[] } | null {
  let chats: string[];
  try {
    chats = readdirSync(peopleDir(data)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { chat: number; at: number } | null = null;
  for (const f of chats) {
    const chat = Number(f.replace(/\.jsonl$/, ""));
    if (Number.isNaN(chat)) continue;
    const last = readSaid(data, chat, 1)?.tail[0];
    if (!last || Number.isNaN(Date.parse(last.at))) continue;
    const at = Date.parse(last.at);
    if (best === null || at > best.at) best = { chat, at };
  }
  if (best === null) return null;
  const tail = readSaid(data, best.chat, limit)?.tail ?? [];
  const last = tail[tail.length - 1];
  if (!last) return null;
  // an outbound line only knows the chat; the name comes from their own lines
  const who =
    last.dir === "in"
      ? (last.from ?? `chat ${best.chat}`)
      : (tail.filter((l) => l.dir === "in").pop()?.from ?? `chat ${best.chat}`);
  return { chat: best.chat, who, at: last.at, tail };
}

/**
 * Conversations where the last thing said was theirs, not ours: somebody is waiting.
 * Purely positional — no reading of what was said.
 */
export function waitingOn(data: string): { who: string; at: string }[] {
  let chats: string[];
  try {
    chats = readdirSync(peopleDir(data)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: { who: string; at: string }[] = [];
  for (const f of chats) {
    const chat = Number(f.replace(/\.jsonl$/, ""));
    if (Number.isNaN(chat)) continue;
    const tail = readSaid(data, chat, 20)?.tail ?? [];
    const last = tail[tail.length - 1];
    if (!last || last.dir !== "in") continue;
    const who =
      last.from ?? tail.filter((l) => l.dir === "in").pop()?.from ?? `chat ${chat}`;
    out.push({ who, at: last.at });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Everybody whose conversation moved since `sinceMs` — however many that turns out to be. */
export function activeSince(data: string, sinceMs: number): { chat: number; who: string }[] {
  let chats: string[];
  try {
    chats = readdirSync(peopleDir(data)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: { chat: number; who: string }[] = [];
  for (const f of chats) {
    const chat = Number(f.replace(/\.jsonl$/, ""));
    if (Number.isNaN(chat)) continue;
    const last = readSaid(data, chat, 20)?.tail ?? [];
    const newest = last[last.length - 1];
    if (!newest || Number.isNaN(Date.parse(newest.at))) continue;
    if (Date.parse(newest.at) < sinceMs) continue;
    const who =
      last.filter((l) => l.dir === "in").pop()?.from ??
      last[last.length - 1]?.from ??
      `chat ${chat}`;
    out.push({ chat, who });
  }
  return out;
}

export interface Transcript {
  total: number;
  bytes: number;
  tail: Said[];
}

/**
 * shortcut: reads the whole file to know how many things were ever said.
 * Only worth fixing past a few MB — at 200 bytes a line that is tens of thousands
 * of messages.
 */
export function readSaid(data: string, chat: number, limit: number): Transcript | null {
  const file = saidFile(data, chat);
  let raw: string;
  let bytes: number;
  try {
    raw = readFileSync(file, "utf8");
    bytes = statSync(file).size;
  } catch {
    return null;
  }
  const all: Said[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<Said>;
      if (typeof parsed.text !== "string" || parsed.text === "") continue;
      all.push({
        at: typeof parsed.at === "string" ? parsed.at : "",
        dir: parsed.dir === "out" ? "out" : "in",
        text: parsed.text,
        from: typeof parsed.from === "string" ? parsed.from : undefined,
      });
    } catch {
      // one broken line must not hide the rest of the conversation
    }
  }
  return { total: all.length, bytes, tail: all.slice(-limit) };
}
