import { join, resolve } from "node:path";

const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface Paths {
  root: string;
  instance: string;
  data: string;
  sessionDir: string;
  palimpsest: string;
  workspace: string;
  usage: string;
  meta: string;
  inbox: string;
  inboxSeen: string;
  inboxLow: string;
  outbox: string;
  acks: string;
  daemonLog: string;
  policy: string;
  identity: string;
  openLoops: string;
  waiting: string;
  waitingConsumed: string;
  intent: string;
  journal: string;
  journalIndex: string;
  secrets: string;
  systemMd: string;
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
  const palimpsest = join(data, "palimpsest");
  const inbox = join(data, "inbox");
  const outbox = join(data, "outbox");
  const journal = join(palimpsest, "journal");
  return {
    root: r,
    instance,
    data,
    sessionDir: join(data, "session"),
    palimpsest,
    workspace: join(data, "workspace"),
    usage: join(data, "usage"),
    meta: join(data, "meta"),
    inbox,
    inboxSeen: join(inbox, "seen"),
    inboxLow: join(inbox, "low"),
    outbox,
    acks: join(outbox, "acks"),
    daemonLog: join(data, "daemon.log"),
    policy: join(palimpsest, "policy.json"),
    identity: join(palimpsest, "identity.md"),
    openLoops: join(palimpsest, "open-loops.json"),
    waiting: join(palimpsest, "waiting.json"),
    waitingConsumed: join(palimpsest, "waiting.consumed.json"),
    intent: join(palimpsest, "intent.json"),
    journal,
    journalIndex: join(journal, "INDEX.md"),
    secrets: join(r, "secrets", `${instance}.env`),
    systemMd: join(r, "deploy", "SYSTEM.md"),
    piDir: join(data, "pi"),
  };
}

/** The agent sees this directory as /state; the daemon sees the same files. */
export const STATE_MOUNT = "/state";
export const WORK_MOUNT = "/work";
export const HOME_MOUNT = "/home/agent";
