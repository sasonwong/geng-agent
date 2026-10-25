import { readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./state.ts";

export interface InboxMsg {
  id: string;
  text: string;
  from?: string;
  at?: string;
}

/**
 * Drain inbox/*.json, moving each file into seen/ before returning it.
 * Anything unparseable is quarantined as *.bad and skipped: one broken
 * message must never block the whole waking.
 */
export function takeInbox(dir: string, seenDir: string): InboxMsg[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  files.sort();
  const out: InboxMsg[] = [];
  for (const f of files) {
    const full = join(dir, f);
    const msg = readJson<InboxMsg | null>(full, null);
    const target = join(seenDir, f);
    try {
      renameSync(full, target);
    } catch {
      rmSync(full, { force: true });
    }
    if (msg && typeof msg.text === "string" && msg.text.trim() !== "") {
      out.push({
        id: typeof msg.id === "string" ? msg.id : f.replace(/\.json$/, ""),
        text: msg.text,
        from: msg.from,
        at: msg.at,
      });
    } else if (msg !== null) {
      renameSync(target, `${target}.bad`);
    } else {
      renameSync(target, `${target}.bad`);
    }
  }
  return out;
}
