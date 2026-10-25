import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./state.ts";

export interface InboxMsg {
  id: string;
  text: string;
  from?: string;
  at?: string;
}

function parseFile(dir: string, name: string): InboxMsg | null {
  const msg = readJson<InboxMsg | null>(join(dir, name), null);
  if (!msg || typeof msg.text !== "string" || msg.text.trim() === "") return null;
  return {
    id: typeof msg.id === "string" ? msg.id : name.replace(/\.json$/, ""),
    text: msg.text,
    from: msg.from,
    at: msg.at,
  };
}

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** Read without consuming — for previews, which must not eat the messages. */
export function peekInbox(dir: string): InboxMsg[] {
  const out: InboxMsg[] = [];
  for (const f of jsonFiles(dir)) {
    const msg = parseFile(dir, f);
    if (msg) out.push(msg);
  }
  return out;
}

/**
 * Drain inbox/*.json, moving each file into seen/ before returning it.
 * Anything unparseable is quarantined as *.bad: one broken message must never
 * block a whole waking.
 */
export function takeInbox(dir: string, seenDir: string, lowDir?: string): InboxMsg[] {
  const out = drain(dir, seenDir);
  if (lowDir) out.push(...drain(lowDir, seenDir));
  return out;
}

function drain(dir: string, seenDir: string): InboxMsg[] {
  const out: InboxMsg[] = [];
  for (const f of jsonFiles(dir)) {
    const msg = parseFile(dir, f);
    const target = join(seenDir, f);
    try {
      renameSync(join(dir, f), target);
    } catch {
      // if the move fails the message stays put and is retried next waking
    }
    if (msg) out.push(msg);
    else {
      try {
        renameSync(target, `${target}.bad`);
      } catch {
        // nothing to quarantine
      }
    }
  }
  return out;
}
