import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./state.ts";

export interface InboxMsg {
  id: string;
  /** The file it came from, so it can be marked seen once it has actually been read. */
  file: string;
  text: string;
  from?: string;
  at?: string;
}

function parseFile(dir: string, name: string): InboxMsg | null {
  const msg = readJson<InboxMsg | null>(join(dir, name), null);
  if (!msg || typeof msg.text !== "string" || msg.text.trim() === "") return null;
  return {
    id: typeof msg.id === "string" ? msg.id : name.replace(/\.json$/, ""),
    file: name,
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
 * Move the messages this wake actually handed over into seen/. Until then they stay
 * put: a cycle that dies before the model reads them must not eat what a human said.
 * Anything unparseable is quarantined as *.bad — one broken message must never block
 * a whole waking.
 */
export function markSeen(dirs: string[], seenDir: string, files: string[]): void {
  for (const file of files) {
    for (const dir of dirs) {
      const from = join(dir, file);
      const to = join(seenDir, file);
      try {
        renameSync(from, to);
      } catch {
        continue; // not in this dir
      }
      try {
        if (parseFile(seenDir, file) === null) renameSync(to, `${to}.bad`);
      } catch {
        // nothing to quarantine
      }
      break;
    }
  }
}
