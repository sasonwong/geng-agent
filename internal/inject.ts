import { readdirSync } from "node:fs";

/**
 * A message that arrives while a waking is running can be handed to it mid-flight
 * instead of waiting for the next one. Only messages the gateway marked as a knock:
 * the group chatter that belongs in the quiet bucket must not interrupt work.
 */
export interface LiveMsg {
  id: string;
  file: string;
  text: string;
  from?: string;
}

/** How many messages may be pushed into one waking. Beyond this they wait. */
export const INJECT_CAP = 6;

export function freshForSteer(pending: LiveMsg[], shown: Set<string>, room: number): LiveMsg[] {
  if (room <= 0) return [];
  return pending.filter((m) => !shown.has(m.id)).slice(0, room);
}

/** A fact with an author, no advice: it interrupts a working turn, so keep it bare. */
export function injectionText(m: LiveMsg): string {
  const who = m.from ?? "有人";
  const text = m.text.replace(/\s+/g, " ").trim();
  return `[刚收到] ${who}：${text.length > 400 ? text.slice(0, 400) + "…" : text}`;
}

/**
 * Which injected messages were actually read. Same order on both sides: the drain hands
 * them over in order and rpc records them in order.
 */
export function deliveredFiles(
  injected: { file: string }[],
  records: { read: boolean }[],
): string[] {
  return injected.filter((_, i) => records[i]?.read === true).map((m) => m.file);
}

/**
 * What it said when it answered without calling `say`. A reply to whoever knocked needs
 * no tool — but only the tool used to write anything, so an answer written as plain text
 * used to vanish.
 */
export function spokenOutbox(
  reason: string,
  finalText: string,
  chat: number | undefined,
  sayHappened: boolean,
): { id: string; messages: string[]; chat: number } | null {
  if (reason !== "knock") return null; // nobody is waiting on a timer wake
  if (sayHappened) return null; // it already spoke; the last text is a summary
  if (typeof chat !== "number") return null;
  const text = finalText.trim();
  if (text === "") return null;
  return { id: `${Date.now()}-spoken`, messages: [text], chat };
}

/** How many messages are waiting to go out; used only to notice that one was written. */
export function countOutbox(dir: string, count = 0): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return count;
  }
}
