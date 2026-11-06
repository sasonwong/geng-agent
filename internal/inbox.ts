import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { readJson } from "./fs.ts";

export interface InboxMsg {
  id: string;
  /** The file it came from, so it can be marked seen once it has actually been read. */
  file: string;
  /** Which half held it. Both inboxes can carry the same file name, and a bare name alone
   *  cannot say which one the page actually handed over. */
  dir?: string;
  text: string;
  from?: string;
  at?: string;
  /** Which address it came from, so its transcript can be found. */
  chat?: number;
  /** What came with it. Voice carries a note instead of an id, on purpose. */
  attachments?: { kind: string; id?: string; name?: string; note?: string; bytes?: number }[];
}

function parseFile(dir: string, name: string): InboxMsg | null {
  const msg = readJson<InboxMsg | null>(join(dir, name), null);
  if (!msg || typeof msg.text !== "string") return null;
  const attachments = Array.isArray(msg.attachments)
    ? msg.attachments.filter((a) => a && typeof a === "object" && typeof a.kind === "string")
    : [];
  // A picture or a document with no caption has no words, and that is not a broken
  // message: the gateway writes text:"" for exactly that. Rejecting it left a file that
  // peekInbox skipped but inboxPending still counted, so the daemon knocked on it every
  // twenty seconds for hours — around sixty cycles — handing over nothing each time.
  if (msg.text.trim() === "" && attachments.length === 0) return null;
  return {
    id: typeof msg.id === "string" ? msg.id : name.replace(/\.json$/, ""),
    file: name,
    dir,
    text: msg.text,
    from: msg.from,
    at: msg.at,
    chat: typeof msg.chat === "number" ? msg.chat : undefined,
    ...(attachments.length === 0 ? {} : { attachments }),
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

/** The newest knock, for the sake of showing "working on it" in the right chat. */
export function newestKnock<T extends { at?: string; chat?: number }>(messages: T[]): T | null {
  const withChat = messages.filter((m) => typeof m.chat === "number");
  if (withChat.length === 0) return null;
  return withChat.reduce((a, b) => ((Date.parse(b.at ?? "") || 0) > (Date.parse(a.at ?? "") || 0) ? b : a));
}

/**
 * Move the messages this wake actually handed over into seen/. Until then they stay
 * put: a cycle that dies before the model reads them must not eat what a human said.
 * Anything unparseable is quarantined as *.bad — one broken message must never block
 * a whole waking.
 */
export type SeenRef = string | { dir?: string; file: string };

export function markSeen(dirs: string[], seenDir: string, files: ReadonlyArray<SeenRef>): void {
  for (const ref of files) {
    const name = typeof ref === "string" ? ref : ref.file;
    const preferred = typeof ref === "string" ? undefined : ref.dir;
    // A bare name cannot say which half held the message: both inboxes can carry
    // `<chat>-<message_id>.json` when a redelivery changed the routing. Prefer the
    // directory the page actually read, and only fall back to scanning the rest.
    const candidates =
      preferred === undefined ? dirs : [preferred, ...dirs.filter((d) => d !== preferred)];
    for (const dir of candidates) {
      const from = join(dir, name);
      if (!existsSync(from)) continue;
      // Two halves holding the same name must both be moved: overwriting the first record
      // in seen/ loses a message, leaving the second in the inbox hands it over again. The
      // source directory's name keeps both records apart.
      let to = join(seenDir, name);
      if (existsSync(to)) to = join(seenDir, `${basename(dir)}-${name}`);
      try {
        renameSync(from, to);
      } catch {
        continue;
      }
      try {
        if (parseFile(seenDir, basename(to)) === null) renameSync(to, `${to}.bad`);
      } catch {
        // nothing to quarantine
      }
      break;
    }
  }
}

/**
 * A file nobody can read used to knock forever: inboxPending counted names while
 * peekInbox skipped the content, so every waking handed over nothing and the file stayed.
 * Anything unparseable is moved aside once, with a line in the log.
 */
export function quarantine(dir: string, seenDir: string, dry = false): string[] {
  const bad: string[] = [];
  for (const f of jsonFiles(dir)) {
    if (parseFile(dir, f) !== null) continue;
    if (dry) {
      // a preview reports what a start would move aside, without moving it
      bad.push(f);
      continue;
    }
    try {
      renameSync(join(dir, f), join(seenDir, `${f}.bad`));
      bad.push(f);
    } catch {
      // if it cannot be moved it will simply be skipped again
    }
  }
  return bad;
}
