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
  /** Which address it came from, so its transcript can be found. */
  chat?: number;
  /** What came with it. Voice carries a note instead of a path, on purpose. */
  attachments?: { kind: string; path?: string; note?: string; bytes?: number }[];
}

/**
 * A document, a photo or a voice note often arrives with nothing typed. The gateway
 * writes those on purpose (it even puts a placeholder in the transcript), so treating
 * "no text" as "not a message" is how one gets lost without ever being shown: it stays
 * in the inbox, never handed over, never marked seen, and only survives as a count.
 */
function parseAttachments(raw: unknown): InboxMsg["attachments"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<InboxMsg["attachments"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.kind !== "string") continue;
    out.push({
      kind: a.kind,
      ...(typeof a.path === "string" ? { path: a.path } : {}),
      ...(typeof a.note === "string" ? { note: a.note } : {}),
      ...(typeof a.bytes === "number" ? { bytes: a.bytes } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseFile(dir: string, name: string): InboxMsg | null {
  const msg = readJson<Record<string, unknown> | null>(join(dir, name), null);
  if (!msg) return null;
  const text = typeof msg.text === "string" ? msg.text : "";
  const attachments = parseAttachments(msg.attachments);
  // Nothing said and nothing carried: not a message. Said nothing but sent something:
  // a message, and the only thing worth passing on is that it is there.
  if (text.trim() === "" && !attachments) return null;
  return {
    id: typeof msg.id === "string" ? msg.id : name.replace(/\.json$/, ""),
    file: name,
    text,
    attachments,
    from: typeof msg.from === "string" ? msg.from : undefined,
    at: typeof msg.at === "string" ? msg.at : undefined,
    chat: typeof msg.chat === "number" ? msg.chat : undefined,
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
/** The newest knock, for the sake of showing "working on it" in the right chat. */
export function newestKnock<T extends { at?: string; chat?: number }>(messages: T[]): T | null {
  const withChat = messages.filter((m) => typeof m.chat === "number");
  if (withChat.length === 0) return null;
  return withChat.reduce((a, b) => ((Date.parse(b.at ?? "") || 0) > (Date.parse(a.at ?? "") || 0) ? b : a));
}

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
