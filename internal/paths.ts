import { join, resolve } from "node:path";

const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface Paths {
  root: string;
  instance: string;
  data: string;
  sessionDir: string;
  book: string;
  workspace: string;
  usage: string;
  meta: string;
  /** One line per tool call, appended when a round ends: the ledger the page counts from.
   * Rebuildable from `session/` if it is ever lost — an index, not a fact. */
  acts: string;
  /** The ceiling each id series has reached, so a deleted file cannot give an old entry's
   * name to a new one. The files are the floor, this is the memory. */
  ids: string;
  /** Sockets, mounted into the container at /run/geng. Under `data/` so the daemon owns
   * one; a socket is not a file anyone can back up, and it never survives a restart. */
  run: string;
  inbox: string;
  inboxSeen: string;
  inboxLow: string;
  /** Every mail it ever received, one file each. Never mounted and never moved: "read" is
   * a list in its own book, not a place files are put. */
  mail: string;
  /** The mail ids it has declared read, written only by the `mail` tool. */
  mailRead: string;
  outbox: string;
  /** Files people sent it. Read-only inside the container, never its business to write. */
  filesDir: string;
  /** What it asked to have forgotten; the daemon applies this before the next waking. */
  filesForget: string;
  daemonLog: string;
  /** Outside the book on purpose: the rules it lives under are not something it reads
   * or writes. The negotiable values reach it through the wake page instead. */
  policy: string;
  identity: string;
  /** A directory, one file per unfinished thing: the count is the filesystem's job. */
  openLoops: string;
  /** One append-only transcript per address, written only by the gateway. */
  people: string;
  waiting: string;
  mute: string;
  /** The chats it asked to be woken by, and until when. Read by the daemon and the gateway. */
  attention: string;
  /** What it asked to change about its own timing; applied once, before the next waking. */
  proposal: string;
  waitingConsumed: string;
  intent: string;
  journal: string;
  journalDiscarded: string;
  secrets: string;
  netLog: string;
  ghAppKey: string;
  systemMd: string;
  /** The tools, from the checkout rather than the image: mounting them read-only means
   *  editing one takes effect on the next waking instead of a rebuild. */
  extensions: string;
  /** Per-instance pi config, mounted read-only over the container's agent dir. */
  piDir: string;
}

export function makePaths(root: string, instance: string): Paths {
  if (!INSTANCE_RE.test(instance)) {
    throw new Error(
      `bad instance name ${JSON.stringify(instance)}: use [a-z0-9_-], start alnum, max 32 chars`,
    );
  }
  const r = resolve(root);
  const data = join(r, "data", instance);
  const book = join(data, "book");
  const inbox = join(data, "inbox");
  const mail = join(data, "mail");
  const outbox = join(data, "outbox");
  const filesDir = join(data, "files");
  const filesForget = join(book, "files.forget.json");
  const journal = join(book, "journal");
  return {
    root: r,
    instance,
    data,
    sessionDir: join(data, "session"),
    book,
    workspace: join(data, "workspace"),
    usage: join(data, "usage"),
    meta: join(data, "meta"),
    acts: join(data, "meta", "acts.jsonl"),
    ids: join(data, "meta", "ids.json"),
    run: join(data, "run"),
    inbox,
    inboxSeen: join(inbox, "seen"),
    inboxLow: join(inbox, "low"),
    mail,
    mailRead: join(book, "mail.read.json"),
    outbox,
    filesDir,
    filesForget,
    daemonLog: join(data, "daemon.log"),
    policy: join(data, "policy.json"),
    identity: join(book, "identity.md"),
    openLoops: join(book, "open-loops"),
    people: join(data, "people"),
    waiting: join(book, "waiting.json"),
    attention: join(book, "attention.json"),
    proposal: join(book, "policy.proposal.json"),
    mute: join(book, "mute.json"),
    waitingConsumed: join(book, "waiting.consumed.json"),
    intent: join(book, "intent.json"),
    journal,
    journalDiscarded: join(journal, "discarded"),
    secrets: join(r, "secrets", `${instance}.env`),
    // outbound connections, one line each: too many for daemon.log, too useful to drop
    netLog: join(data, "net.log"),
    // never mounted, never in an env file: the daemon signs with it and nothing else reads it
    ghAppKey: join(r, "secrets", "gh-app.pem"),
    systemMd: join(r, "deploy", "SYSTEM.md"),
    extensions: join(r, "image", "extensions"),
    piDir: join(data, "pi"),
  };
}

/**
 * One list, because two lists drift exactly when you are debugging: init and the daemon
 * both create the state tree, and a directory added to one but not the other fails
 * silently at run time.
 */
export function requiredDirs(p: Paths): string[] {
  return [
    p.data,
    p.sessionDir,
    p.book,
    p.journal,
    p.journalDiscarded,
    p.workspace,
    p.usage,
    p.meta,
    p.inbox,
    p.inboxSeen,
    p.inboxLow,
    p.mail,
    p.outbox,
    p.piDir,
    p.openLoops,
    p.people,
    p.filesDir,
    p.run,
  ];
}
