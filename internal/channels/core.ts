import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { attentionActive, readAttention } from "../attention.ts";
import { appendSaid, saidHasId } from "../people.ts";
import { hostPathForWorkPath, placeholderFor, type Attachment } from "../attach.ts";
import { newFile } from "../ids.ts";
import { readJson, writeJson } from "../fs.ts";
import { isMuted, readMutes, writeOps } from "../mute.ts";
import type { Paths } from "../paths.ts";
import type {
  Chats,
  Inbound,
  KnownChat,
  RemoteAttachment,
  SendStep,
} from "./channel.ts";

export type RouteReason = "dm" | "mention" | "reply" | "listen" | "ambient" | "muted" | "guest" | "skip";

export interface RouteInput {
  /** False: not on the whitelist, so nothing about it is kept at all. */
  allowed: boolean;
  isDm: boolean;
  isMention: boolean;
  isReply: boolean;
  listen: "all" | "mentions";
  muted: boolean;
  /** It asked to hear this chat for a while, so plain talk there wakes it too. */
  listening: boolean;
}

export interface Route {
  deliver: boolean;
  /** A knock wakes it; the rest waits for a waking that is happening anyway. */
  high: boolean;
  reason: RouteReason;
}

/**
 * Direct address always wins, mute only silences the ambient. That is the whole
 * delivery policy: high frequency calls it, low frequency waits for it.
 */
export function route(i: RouteInput): Route {
  // before everything else, including silent-looking ambient: a stranger must not even
  // be able to land in the pull bucket
  if (!i.allowed) return { deliver: false, high: false, reason: "guest" };
  if (i.isDm) return { deliver: true, high: true, reason: "dm" };
  if (i.isMention) return { deliver: true, high: true, reason: "mention" };
  if (i.isReply) return { deliver: true, high: true, reason: "reply" };
  if (i.listening) return { deliver: true, high: true, reason: "listen" };
  if (i.listen === "mentions") return { deliver: false, high: false, reason: "skip" };
  return { deliver: true, high: false, reason: i.muted ? "muted" : "ambient" };
}

export function readChats(file: string): Record<string, Chats> {
  const raw = readJson<Record<string, unknown>>(file, {});
  const out: Record<string, Chats> = {};
  for (const [key, value] of Object.entries(raw)) {
    // the first shape was a bare chat id per instance
    if (typeof value === "number") out[key] = { home: value, known: {} };
    else if (value && typeof value === "object") out[key] = value as Chats;
  }
  return out;
}

export function noteChat(chats: Chats, chat: KnownChat, id: number, seen: boolean): boolean {
  const known = (chats.known ??= {});
  const key = String(id);
  const before = JSON.stringify(known[key] ?? null);
  known[key] = seen ? { ...chat } : (known[key] ?? chat);
  // An unprompted word must not land in a room with an audience, so a private chat beats
  // a group as home — and a channel that can actually open a conversation beats one that
  // can only answer. Only the first of a rank wins: whoever spoke last still decides nothing.
  const rank = (cid: number): number => {
    const c = known[String(cid)];
    if (!c) return 0;
    if (typeof c.homeRank === "number") return c.homeRank;
    return c.kind === "private" ? 2 : 0;
  };
  if (chats.home === undefined || rank(id) > rank(chats.home)) chats.home = id;
  return JSON.stringify(known[key]) !== before;
}

/**
 * Fetch what came with a message and give it an id.
 *
 * The two writers of `files/` — this one and the mail endpoint — must name a file the same
 * way, or one of them produces files the other's readers cannot see: stored, backed up,
 * counted as disk use, and unreachable by `download`, `say` or `recall`.
 *
 * The channel only supplies `download`; the id and the refusal stay here, so a new
 * transport cannot invent a second naming scheme.
 */
export async function storeRemoteAttachment(
  paths: Paths,
  key: string,
  att: RemoteAttachment,
  ops: string,
): Promise<Attachment> {
  const meta: Attachment = {
    kind: att.kind,
    ...(att.name === undefined ? {} : { name: att.name }),
    ...(att.bytes === undefined ? {} : { bytes: att.bytes }),
    ...(att.note === undefined ? {} : { note: att.note }),
  };
  // a channel that chose not to fetch it (voice with no transcript) has nothing to store
  if (att.download === undefined) return meta;
  const { id, file } = newFile(paths, 0, att.name ?? "file");
  try {
    const bytes = await att.download(file);
    return { ...meta, id, bytes };
  } catch (err) {
    writeOps(ops, "gateway", `${key} 的文件没取到：${(err as Error).message}`);
    return { ...meta, note: "没取到" };
  }
}

/**
 * What a redelivered message keeps: the file the first delivery already stored.
 *
 * A channel hands a message over again when a round crashed between handling it and
 * recording the cursor, and the media behind `<chat>-<nativeId>` cannot have changed.
 * Re-fetching it allocated a second id, so the inbox record's pointer moved to the new copy
 * and the first one stayed behind — stored, counted by the size cap, reachable by
 * `download` and listed by `recall`, with nothing pointing at it.
 *
 * A first delivery that failed (`note: 没取到`, no id) has nothing to keep, so a
 * redelivery retries the download.
 */
export function alreadyStored(previous: { attachments?: Attachment[] } | null): Attachment | undefined {
  const had = previous?.attachments?.[0];
  return had !== undefined && had.id !== undefined ? had : undefined;
}

/**
 * A failed send is not a lost message and not an infinite retry.
 *
 * The sweep hands every outbox item back every two seconds, so acknowledging a failed one
 * made a two-second network blip unrecoverable: the words were gone and the only trace was
 * a line in the ops queue the agent cannot read. Retrying forever is the other wrong
 * answer — a chat the bot was thrown out of would keep the whole instance's outbox stuck
 * and, via the tripwire, mute it. Five attempts, then one line, and the file is moved to
 * `outbox/sent/` with its words intact.
 */
export const SEND_ATTEMPTS = 5;

/**
 * A message whose handling keeps failing is retried, then let go of with one line — the
 * same deal a failed send gets. Advancing a cursor on the first failure turns a transient
 * write error (a full disk, a permissions blip) into a message lost for good: a channel
 * never hands over an update behind a recorded cursor again.
 */
export const HANDLE_ATTEMPTS = 5;

/**
 * The upload half of an item, decided once, before anything is sent.
 *
 * Two reasons it is a plan and not a loop over `files` followed by a loop over
 * `attachments`: a `/work` path that cannot be published is refused here (a retry would
 * otherwise repeat the same line every two seconds), and the retry needs to know exactly
 * which of these already went out. A counted prefix over the two lists did not survive a
 * refusal in the middle: `["/etc/x", "/work/ok"]` would keep the refused one and drop the
 * sent one.
 */
export function sendPlan(
  workspace: string,
  files: string[],
  attachments: { path: string; name: string }[],
): { steps: SendStep[]; refused: string[] } {
  const steps: SendStep[] = [];
  const refused: string[] = [];
  for (const given of files) {
    // the path came from inside the container, so it can be anything it likes: only
    // /work is its own, and only files that exist there are sent
    const host = hostPathForWorkPath(workspace, given);
    if (host === null) {
      refused.push(given);
      continue;
    }
    steps.push({ given, path: host, name: basename(host), kind: "work" });
  }
  // the daemon resolved these from ids it handed out, so they are already host paths;
  // nothing here can be talked into reading somewhere else
  for (const a of attachments) steps.push({ given: a.path, path: a.path, name: a.name, kind: "file" });
  return { steps, refused };
}

export function failedAttempt(
  failures: Map<string, number>,
  file: string,
  max = SEND_ATTEMPTS,
): { n: number; giveUp: boolean } {
  const n = (failures.get(file) ?? 0) + 1;
  failures.set(file, n);
  return { n, giveUp: n >= max };
}

/**
 * Which pollers a reload has to move. A poller is a long poll holding a token, so only a
 * token that changed (or an instance that came or went) needs a new one: allow and listen
 * are read per message from the config, which is swapped under it.
 */
export function reloadPlan(
  running: Record<string, string>,
  next: Record<string, string>,
): { stop: string[]; start: string[] } {
  return {
    stop: Object.keys(running).filter((k) => running[k] !== next[k]).sort(),
    start: Object.keys(next).filter((k) => next[k] !== running[k]).sort(),
  };
}

/**
 * Where a send goes: the chat the item names, else the channel's pinned target, else the
 * first chat this instance ever heard from. `null` is "nowhere" — nothing named a target
 * and nobody has ever written to it, so there is no address a retry could ever reach.
 */
export function targetChat(
  want: number | undefined,
  pinned: number | undefined,
  home: number | undefined,
): number | null {
  const chat = want ?? pinned ?? home;
  return typeof chat === "number" ? chat : null;
}

/** What the core needs from the gateway to keep one message: its state, not its wire. */
export interface InboundHost {
  root: string;
  chats: Record<string, Chats>;
  chatsFile: string;
  ops: string;
  log(line: string): void;
  instanceData(instance: string): Paths | null;
}

/**
 * One inbound message, whichever channel carried it.
 *
 * Everything that decides whether it is kept, where it lands and what the transcript says
 * lives here. A channel that has to know about `inbox/low` or `people/` is a channel that
 * will disagree with the next one.
 */
export async function handleInbound(host: InboundHost, key: string, msg: Inbound): Promise<void> {
  // A pure whitelist, checked before anything else: a stranger must not be able to wake
  // it, fill its inbox, download a file into /files, or — while the channel is new —
  // become the home that unprompted words are later sent to.
  if (!msg.allowed) {
    // the id is printed because it is exactly what has to be pasted into the allow list
    host.log(`${key} ← guest ${msg.fromId ?? "?"}（没送）`);
    return;
  }
  const att = msg.attachments[0] ?? null;
  if (msg.text === "" && att === null) {
    // A sticker is an attachment, so what lands here is a poll, a location, a dice —
    // something with neither words nor a file.
    host.log(`${key} ← 忽略（没有文字也没有附件）`);
    return;
  }
  const mine = (host.chats[key] ??= { known: {} });
  const seen = noteChat(
    mine,
    {
      kind: msg.chatKind,
      ...(msg.who === undefined ? {} : { who: msg.who }),
      ...(msg.chatTitle === undefined ? {} : { title: msg.chatTitle }),
      channel: msg.channel,
      ...(msg.channelLabel === undefined ? {} : { label: msg.channelLabel }),
      ...(msg.homeRank === undefined ? {} : { homeRank: msg.homeRank }),
      ...(msg.canFile === undefined ? {} : { canFile: msg.canFile }),
      ...(msg.canQuote === undefined ? {} : { canQuote: msg.canQuote }),
    },
    msg.chat,
    msg.chatKind !== "private",
  );
  if (seen) writeJson(host.chatsFile, host.chats);

  if (key === "ops") {
    host.log(`ops 收到消息（不处理）：${msg.who ?? "?"}`);
    return;
  }
  const p = host.instanceData(key);
  if (!p) {
    writeOps(host.ops, "gateway", `收到发给未知实例 ${key} 的消息，已忽略。`);
    return;
  }

  const now = Date.now();
  const mutes = readMutes(join(p.book, "mute.json"), now);
  const attention = readAttention(p.attention, now);
  const decision = route({
    allowed: true,
    isDm: msg.isDm,
    isMention: msg.isMention,
    isReply: msg.isReply,
    listen: msg.listen,
    muted: isMuted(mutes, msg.chat).muted,
    listening: attentionActive(attention, msg.chat, now),
  });

  if (!decision.deliver) {
    host.log(`${key} ← ${decision.reason}（没送）`);
    return;
  }

  const dir = decision.high ? p.inbox : p.inboxLow;
  const id = `${msg.chat}-${msg.nativeId}`;
  const file = join(dir, `${id}.json`);
  // A redelivered message (crash between handling and recording the cursor) lands on the
  // same file: rewrite it, but do not log the same words twice. The record can also sit in
  // seen/ — a round finished with it while the cursor never moved — or in the other half
  // of the inbox, if the route changed in between; either way it is the same message, not
  // a new one, and its stored file must not be fetched again.
  const previous = [p.inbox, p.inboxLow, p.inboxSeen]
    .map((d) => join(d, `${id}.json`))
    .find((f) => existsSync(f));
  const redelivered = previous !== undefined;
  // fetch first, so the message is never announced without the thing it came with —
  // unless the first delivery already did (see alreadyStored)
  let stored: Attachment | null = null;
  if (att) {
    const had = redelivered
      ? alreadyStored(previous === undefined ? null : readJson<{ attachments?: Attachment[] } | null>(previous, null))
      : undefined;
    stored = had ?? (await storeRemoteAttachment(p, key, att, host.ops));
  }
  // the same message must not sit in two halves at once: the round reads them both
  if (previous !== undefined && previous !== file && dirname(previous) !== p.inboxSeen) {
    try {
      rmSync(previous, { force: true });
    } catch {
      // the next round moves it aside anyway
    }
  }
  // The quote is not copied here: the transcript line below carries it, and that is what
  // the page and `open("P…")` read. A second copy in a file no reader opens is a field
  // somebody has to keep true for nothing.
  writeJson(file, {
    id,
    text: msg.text,
    ...(msg.who === undefined ? {} : { from: msg.who }),
    at: msg.at,
    chat: msg.chat,
    ...(stored ? { attachments: [stored] } : {}),
  });
  // Only what was actually delivered: a message the policy chose not to forward must
  // not reappear later in the transcript. Guarded by the id, not by "first delivery":
  // a redelivery whose record the round already consumed would otherwise be logged as
  // new words again, and a first delivery whose transcript write failed would never be.
  if (!saidHasId(p.data, msg.chat, id)) {
    // the transcript keeps a placeholder so a file does not read as silence
    const said = msg.text !== "" ? msg.text : placeholderFor(stored ? [stored] : []);
    appendSaid(p.data, msg.chat, {
      at: msg.at,
      dir: "in",
      text: said,
      ...(msg.who === undefined ? {} : { from: msg.who }),
      id,
      ...(msg.quote === undefined ? {} : { quote: msg.quote }),
    });
  }
  host.log(
    `${key} ← ${decision.reason}${decision.high ? " (唤醒)" : ""}${
      stored ? ` ${stored.kind}${stored.note ? `(${stored.note})` : ""}` : ""
    }`,
  );
}
