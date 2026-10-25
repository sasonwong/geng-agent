import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
}

export function peopleDir(data: string): string {
  return join(data, "people");
}

export function saidFile(data: string, chat: number): string {
  return join(peopleDir(data), `${chat}.jsonl`);
}

export function appendSaid(data: string, chat: number, entry: Said): void {
  const dir = peopleDir(data);
  mkdirSync(dir, { recursive: true });
  appendFileSync(saidFile(data, chat), JSON.stringify(entry) + "\n");
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
