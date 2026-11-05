import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { attentionActive, parseAttention } from "./attention.ts";
import { Tripwire } from "./tripwire.ts";
import { quoteFor, quotedOf } from "./quote.ts";
import { ExpectedError } from "./errors.ts";
import type { Paths } from "./paths.ts";
import { makePaths } from "./paths.ts";
import { appendSaid } from "./people.ts";
import { attachmentOf, hostPathForWorkPath, placeholderFor, type Attachment } from "./attach.ts";
import { newestKnock, peekInbox } from "./inbox.ts";
import { describeConfig, loadMailConfig, readMailEnv, startMailServer } from "./mail.ts";
import { ensureGatewayDirs, ackOutbox, isMuted, outboxDir, readMutes, readOutbox, writeOps } from "./mute.ts";
import { readBots, type Bots } from "./bots.ts";
import { newFile } from "./ids.ts";
import { readJson, writeJson } from "./fs.ts";
import {
  getMe,
  getUpdates,
  isMentioned,
  isReplyToBot,
  downloadFile,
  getFilePath,
  sendFile,
  sendMessage,
  sendTyping,
  senderName,
  nameOf,
  type BotConfig,
  type BotIdentity,
  type TgUpdate,
} from "./telegram.ts";

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

export interface GatewayOptions {
  root: string;
  log?: (line: string) => void;
}

/**
 * One entry per chat this instance has ever been seen in. `home` is learned once and
 * then left alone: whoever spoke last must not decide where an unprompted word lands.
 */
export interface KnownChat {
  kind: "private" | "group";
  who?: string;
  title?: string;
}

export interface Chats {
  home?: number;
  known?: Record<string, KnownChat>;
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
  // a group as home — but only the first of each: whoever spoke last still decides nothing.
  const homeIsPrivate =
    chats.home !== undefined && known[String(chats.home)]?.kind === "private";
  if (chats.home === undefined) chats.home = id;
  else if (chat.kind === "private" && !homeIsPrivate) chats.home = id;
  return JSON.stringify(known[key]) !== before;
}

/** What the daemon shows the agent about where it may speak. */
export function knownPlaces(
  root: string,
  key: string,
): { id: number; label: string; home: boolean; kind: "private" | "group" }[] {
  const chats = readChats(join(root, "data", "_gateway", "chats.json"))[key];
  if (!chats) return [];
  const home = chats.home;
  return Object.entries(chats.known ?? {}).map(([id, c]) => ({
    id: Number(id),
    label: c.kind === "private" ? `私聊${c.who ? ` ${c.who}` : ""}` : `群「${c.title ?? id}」`,
    home: Number(id) === home,
    kind: c.kind,
  }));
}

/**
 * Fetch what came with a message and give it an id.
 *
 * The two writers of `files/` — this one and the mail endpoint — must name a file the same
 * way, or one of them produces files the other's readers cannot see: stored, backed up,
 * counted as disk use, and unreachable by `download`, `say` or `recall`.
 */
export async function storeAttachment(
  paths: Paths,
  key: string,
  token: string,
  att: Attachment,
  ops: string,
): Promise<void> {
  if (!att.fileId) return;
  const { id, file } = newFile(paths, 0, att.name ?? "file");
  try {
    const filePath = await getFilePath(token, att.fileId);
    const bytes = await downloadFile(token, filePath, file);
    att.id = id;
    att.bytes = bytes;
  } catch (err) {
    writeOps(ops, "gateway", `${key} 的文件没取到：${(err as Error).message}`);
    att.note = "没取到";
  }
}

/**
 * What a redelivered message keeps: the file the first delivery already stored.
 *
 * Telegram hands a message over again when a round crashed between handling it and
 * recording the offset, and the media behind `<chat>-<message_id>` cannot have changed.
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
 * (the old behaviour) made a two-second network blip unrecoverable: the words were gone and
 * the only trace was a line in the ops queue the agent cannot read. Retrying forever is the
 * other wrong answer — a chat the bot was thrown out of would keep the whole bot's outbox
 * stuck and, via the tripwire, mute it. Five attempts, then one line, and the file is moved
 * to `outbox/sent/` with its words intact.
 */
export const SEND_ATTEMPTS = 5;

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
 * The brake's numbers. The window/limit/pause live here; the recording lives in
 * internal/tripwire.ts, because the order of "look at the pause" vs "record an attempt"
 * is the whole difference between a brake and a lockup.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const REPEAT_LIMIT = 10;
const PAUSE_MS = 10 * 60_000;

/**
 * Which pollers a reload has to move. A poller is a long poll holding a token, so only a
 * token that changed (or a bot that came or went) needs a new one: allow, listen and chat
 * are read per message from `bots`, which is swapped under it.
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
 * What a reload does with a bot whose token is missing or blank.
 *
 * A token is the one thing a reload cannot invent, so a missing one must mean "keep the
 * token this poller already holds" — deleting the entry instead stops the poller and takes
 * the bot down, which is the opposite of what the log line promises. A half-written
 * `bots.json` is exactly the case a reload is supposed to survive.
 *
 * A bot that has no token and no old one is dropped: there is nothing to poll with.
 *
 * `next` is the JSON as it was read, so it is deliberately typed as partial: a file that is
 * being written has holes, and the type says so rather than lying about it.
 */
export function mergeBots(
  running: Bots,
  next: Record<string, Partial<BotConfig>>,
): { bots: Bots; notes: string[] } {
  const bots: Bots = {};
  const notes: string[] = [];
  for (const [key, cfg] of Object.entries(next)) {
    const token = cfg.token;
    if (typeof token === "string" && token.trim() !== "") {
      bots[key] = { ...cfg, token };
      continue;
    }
    const old = running[key];
    if (old) {
      bots[key] = { ...cfg, token: old.token };
      notes.push(`重载：${key} 没有 token，沿用旧的`);
    } else {
      notes.push(`重载：${key} 没有 token，也没有旧的可用，跳过`);
    }
  }
  return { bots, notes };
}

/**
 * Where a send goes: the chat the item names, else the one `bots.json` pins, else the first
 * chat this bot ever heard from. `null` is "nowhere" — nothing named a target and nobody has
 * ever written to it, so there is no address a retry could ever reach.
 */
export function targetChat(
  want: number | undefined,
  pinned: number | undefined,
  home: number | undefined,
): number | null {
  const chat = want ?? pinned ?? home;
  return typeof chat === "number" ? chat : null;
}

export interface PartialSend {
  texts: number;
  files: number;
  attachments: number;
}

/**
 * What is still owed after a send that broke halfway. The sweep hands the same outbox
 * file back every two seconds, so anything already delivered has to come out of it —
 * otherwise the words are spoken again on every retry, and the burst trips the rate
 * brake for ten minutes.
 */
export function unsentPart(
  o: {
    chat?: number;
    messages: string[];
    files: string[];
    attachments: { path: string; name: string; id?: string }[];
    replyTo?: { chat: number; messageId: number };
  },
  sent: PartialSend,
): Record<string, unknown> {
  return {
    ...(o.chat === undefined ? {} : { chat: o.chat }),
    messages: o.messages.slice(sent.texts),
    files: o.files.slice(sent.files),
    attachments: o.attachments.slice(sent.attachments),
    ...(o.replyTo === undefined ? {} : { replyTo: o.replyTo }),
  };
}

export async function runGateway(o: GatewayOptions): Promise<void> {
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const root = o.root;
  const botsFile = join(root, "secrets", "bots.json");
  // both are re-read on SIGHUP: editing either one is an operator action, and restarting
  // the process for it would drop the long polls and re-login every bot
  let bots = readBots(root);
  // a mailbox is a transport too: an instance may have mail and no bot at all
  const loadedMail = loadMailConfig(root);
  // a box rather than a bare `let`: the getter handed to the mail server stays non-null
  // for the life of the process, and only its contents are swapped by a reload
  const mailbox = loadedMail === null ? null : { cfg: loadedMail };
  if (Object.keys(bots).length === 0 && mailbox === null) {
    throw new ExpectedError(
      `没有 bot 也没有信箱：先写 ${botsFile} 或 ${join(root, "secrets", "mail.json")}`,
    );
  }

  const { ops } = ensureGatewayDirs(root);
  const chatsFile = join(root, "data", "_gateway", "chats.json");
  const offsetsFile = join(root, "data", "_gateway", "offsets.json");
  const chats = readChats(chatsFile);
  const offsets = readJson<Record<string, number>>(offsetsFile, {});
  const watch = new Map<string, Tripwire>();

  const watchFor = (key: string): Tripwire => {
    let w = watch.get(key);
    if (!w) {
      w = new Tripwire({ windowMs: RATE_WINDOW_MS, rate: RATE_LIMIT, repeat: REPEAT_LIMIT, pauseMs: PAUSE_MS });
      watch.set(key, w);
    }
    return w;
  };

  /** Tripwires look only at shape — rate and repetition. Never at meaning. */
  const trip = (key: string, texts: string[]): string | null => {
    const w = watchFor(key);
    const verdict = w.check(texts, Date.now());
    if (verdict === "rate") {
      writeOps(ops, "gateway", `${key} 在 1 分钟内要发 ${w.attempts} 条，暂停投递 10 分钟。消息没丢。`);
    } else if (verdict === "repeat") {
      writeOps(ops, "gateway", `${key} 连续发了同一句话 ${REPEAT_LIMIT} 次，暂停投递 10 分钟。消息没丢。`);
    }
    return verdict;
  };

  const instanceData = (key: string): Paths | null => {
    try {
      return makePaths(root, key);
    } catch {
      return null;
    }
  };

  const deliver = async (
    key: string,
    texts: string[],
    want?: number,
    files: string[] = [],
    replyTo?: { chat: number; messageId: number },
    attachments: { path: string; name: string }[] = [],
    /** The outbox file, so a partial success can put only the unsent part back. */
    queueFile?: string,
  ): Promise<boolean> => {
    const cfg = bots[key];
    if (!cfg) return false;
    const mine = (chats[key] ??= { known: {} });
    // bots.json can pin the home; otherwise the first chat it ever heard from is home,
    // and a later group must be named explicitly to be spoken into
    const chat = targetChat(want, cfg.chat, mine.home);
    if (chat === null) {
      // Not a failure to retry: the sweep hands this back every two seconds and nothing
      // will have changed. Acknowledged, with one line, because the words were queued as
      // if they had somewhere to go and that is the part a person has to be told.
      writeOps(
        ops,
        "gateway",
        `${key} 没有地方可发：bots.json 里没写 chat，也还没有人跟这个 bot 说过话。这条没送到，文件在 outbox/sent/ 里。`,
      );
      return true;
    }
    if (want !== undefined && !mine.known?.[String(want)]) {
      writeOps(ops, "gateway", `${key} 要发给不认识的 chat ${want}，没发。`);
      return true; // acknowledged: retrying will never make it known
    }
    if (trip(key, texts)) return false;
    // a quote only means something inside the chat it came from; a mismatched one is
    // dropped rather than sent into the wrong conversation
    const reply = quoteFor(chat, replyTo);

    // A failure halfway through used to hand the whole item back to the sweep: words
    // already spoken were spoken again on every retry (five of them), and the burst then
    // tripped the rate brake for ten minutes. Put only what did not go out back into
    // the queue before letting the sweep retry.
    let sentTexts = 0;
    let sentFiles = 0;
    let sentAttachments = 0;
    const keepUnsent = (): void => {
      if (queueFile === undefined) return;
      try {
        writeJson(queueFile, {
          id: basename(queueFile, ".json"),
          ...unsentPart(
            { chat: want, messages: texts, files, attachments, replyTo },
            { texts: sentTexts, files: sentFiles, attachments: sentAttachments },
          ),
        });
      } catch {
        // the sweep retries the whole item; that is the old behaviour, and still beats
        // losing the words altogether
      }
    };

    const ids: (number | undefined)[] = [];
    const p = instanceData(key);
    try {
      for (const text of texts) {
        if (reply === undefined) {
          ids.push((await sendMessage(cfg.token, chat, text))[0]);
        } else {
          try {
            ids.push((await sendMessage(cfg.token, chat, text, reply))[0]);
          } catch {
            // a deleted message must not take the words down with it
            ids.push((await sendMessage(cfg.token, chat, text))[0]);
          }
        }
        sentTexts += 1;
      }
      for (const given of files) {
        // the path came from inside the container, so it can be anything it likes: only
        // /work is its own, and only files that exist there are sent
        const host = hostPathForWorkPath(p?.workspace ?? "", given);
        if (host === null) {
          writeOps(ops, "gateway", `${key} 想发 ${given}，那不是 /work 里的文件，没发。`);
          sentFiles += 1; // a refused path will never succeed on a retry either
          continue;
        }
        await sendFile(cfg.token, chat, host);
        sentFiles += 1;
      }
      // the daemon resolved these from ids it handed out, so they are already host paths;
      // nothing here can be talked into reading somewhere else
      for (const a of attachments) {
        await sendFile(cfg.token, chat, a.path);
        sentAttachments += 1;
      }
    } catch (err) {
      keepUnsent();
      throw err;
    }
    if (p) {
      for (const [i, text] of texts.entries()) {
        // The id Telegram gave the first part of this text: `<chat>-<message_id>`, the
        // same shape the inbox uses, so a line of its own can be pointed at later just
        // like anyone else's. Absent only if the send answered without one.
        const id = ids[i];
        appendSaid(p.data, chat, {
          at: new Date().toISOString(),
          dir: "out",
          text,
          ...(id === undefined ? {} : { id: `${chat}-${id}` }),
        });
      }
    }
    return true;
  };

  const handleUpdate = async (key: string, me: BotIdentity, update: TgUpdate): Promise<void> => {
    const message = update.message;
    if (!message) return;
    const cfg = bots[key];
    if (!cfg) return;
    // A pure whitelist, checked before anything else: a stranger must not be able to wake
    // it, fill its inbox, download a file into /files, or — while the bot is new — become
    // the home that unprompted words are later sent to.
    const allowed = !cfg.allow || cfg.allow.includes(message.from?.id ?? 0);
    if (!allowed) {
      // the id is printed because it is exactly what has to be pasted into bots.json
      log(`${key} ← guest ${message.from?.id ?? "?"}（没送）`);
      return;
    }
    // text, or a caption on an attachment; anything else still has to be accounted for
    const words = message.text ?? message.caption ?? "";
    let att = attachmentOf(message);
    if (words === "" && att === null) {
      // A sticker is an attachment (`attachmentOf`), so it never reaches this branch: what
      // lands here is a poll, a location, a dice — something with neither words nor a file.
      log(`${key} ← 忽略（没有文字也没有附件）`);
      return;
    }
    const mine = (chats[key] ??= { known: {} });
    const seen = noteChat(
      mine,
      message.chat.type === "private"
        ? { kind: "private", who: senderName(message) }
        : { kind: "group", title: message.chat.title ?? `chat ${message.chat.id}` },
      message.chat.id,
      message.chat.type !== "private",
    );
    if (seen) writeJson(chatsFile, chats);

    if (key === "ops") {
      log(`ops 收到消息（不处理）：${senderName(message)}`);
      return;
    }
    const p = instanceData(key);
    if (!p) {
      writeOps(ops, "gateway", `收到发给未知实例 ${key} 的消息，已忽略。`);
      return;
    }

    const listen = cfg.listen ?? "all";
    const mutes = readMutes(join(p.book, "mute.json"), Date.now());
    const attention = parseAttention(readJson(p.attention, null));
    const muted = isMuted(mutes, message.chat.id);

    const decision = route({
      allowed,
      isDm: message.chat.type === "private",
      isMention: isMentioned(message, me),
      isReply: isReplyToBot(message, me),
      listen,
      muted: muted.muted,
      listening: attentionActive(attention, message.chat.id, Date.now()),
    });

    if (!decision.deliver) {
      log(`${key} ← ${decision.reason}（没送）`);
      return;
    }

    const dir = decision.high ? p.inbox : p.inboxLow;
    const id = `${message.chat.id}-${message.message_id}`;
    const file = join(dir, `${id}.json`);
    // a redelivered message (crash between handling and recording the offset) lands on
    // the same file: rewrite it, but do not log the same words twice
    const redelivered = existsSync(file);
    // fetch first, so the message is never announced without the thing it came with —
    // unless the first delivery already did (see alreadyStored)
    if (att) {
      const had = redelivered
        ? alreadyStored(readJson<{ attachments?: Attachment[] } | null>(file, null))
        : undefined;
      if (had !== undefined) att = had;
      else await storeAttachment(p, key, cfg.token, att, ops);
    }
    const quoted = quotedOf(message.chat.id, message.reply_to_message, nameOf);
    const at = new Date().toISOString();
    writeJson(file, {
      id,
      text: words,
      from: senderName(message),
      at,
      chat: message.chat.id,
      route: decision.reason,
      ...(att ? { attachments: [att] } : {}),
      ...(quoted ? { quote: quoted } : {}),
    });
    // Only what was actually delivered: a message the policy chose not to forward must
    // not reappear later in the transcript.
    if (!redelivered) {
      // the transcript keeps a placeholder so a file does not read as silence
      const said = words !== "" ? words : placeholderFor(att ? [att] : []);
      appendSaid(p.data, message.chat.id, {
        at,
        dir: "in",
        text: said,
        from: senderName(message),
        id,
        ...(quoted ? { quote: quoted } : {}),
      });
    }
    log(
      `${key} ← ${decision.reason}${decision.high ? " (唤醒)" : ""}${att ? ` ${att.kind}${att.note ? `(${att.note})` : ""}` : ""}`,
    );
  };

  const poll = async (key: string, signal: AbortSignal): Promise<void> => {
    const cfg = bots[key];
    if (!cfg) return;
    const me = await getMe(cfg.token);
    // the whitelist is printed because a wrong one is silent: too few and nobody can
    // wake it, one missing id and its conversation partner quietly stops reaching it
    const allow =
      cfg.allow === undefined
        ? "allow=不限"
        : cfg.allow.length === 0
          ? "allow=0（谁都进不来）"
          : `allow=${cfg.allow.length} 人`;
    log(
      `${key} 上线：@${me.username}${cfg.listen ? ` listen=${cfg.listen}` : ""} ${allow}` +
        ` home=${cfg.chat ?? chats[key]?.home ?? "未知"}`,
    );
    for (;;) {
      const updates = await getUpdates(cfg.token, offsets[key] ?? 0, undefined, signal);
      if (signal.aborted) return;
      for (const update of updates) {
        // Handle first, record the offset after: recording it first means a crash in
        // between loses the message for good, and Telegram will never hand it over again.
        try {
          await handleUpdate(key, me, update);
        } catch (err) {
          writeOps(ops, "gateway", `${key} 处理消息出错：${(err as Error).message}`);
        }
        offsets[key] = update.update_id + 1;
        writeJson(offsetsFile, offsets);
      }
    }
  };

  // One long poll per bot, keyed so a reload can stop exactly the one it has to. Telegram
  // allows one consumer per token: a changed token means the old poll must end before the
  // new one starts, or both get 409 and the bot looks dead.
  const pollers = new Map<string, { token: string; stop: () => Promise<void> }>();

  // one reload at a time: two SIGHUPs a second apart must not stop the same poller twice.
  // A SIGHUP that arrives mid-reload leaves a mark and gets its own pass afterwards, so
  // an edit made during a reload is read instead of being silently lost.
  let reloading: Promise<void> | null = null;
  let reloadAgain = false;

  /**
   * Nothing left to serve means exit, not "stay alive and look healthy". A bad token used
   * to leave the process holding a promise that never settles: systemd said active and
   * only journald knew. Exiting makes the unit retry, which is what a wrong token needs.
   *
   * A mailbox is still a job, and a reload is momentarily between stop and start — exiting
   * there would turn one config edit into a restart loop.
   */
  const exitIfIdle = (): void => {
    if (pollers.size > 0 || mailbox !== null || reloading !== null) return;
    log("没有轮询也没有信箱：退出，unit 会重试");
    process.exit(1);
  };

  const startPoller = (key: string): void => {
    const cfg = bots[key];
    if (!cfg || pollers.has(key)) return;
    const ac = new AbortController();
    const done = poll(key, ac.signal).catch((err: unknown) => {
      if (ac.signal.aborted) return;
      // this entry is still in the map here, so more than one means another bot is alive;
      // exitIfIdle will then not exit, and nothing else ever restarts this one
      const line = `${key} 的轮询断了：${(err as Error).message}${
        pollers.size > 1 ? "（别的 bot 还在跑，它要 reload 一次才回来）" : ""
      }`;
      log(line);
      // the same fact in the only place a person looks: journald alone is not a signal
      writeOps(ops, "gateway", line);
    });
    const entry = { token: cfg.token, stop: async () => {
      ac.abort();
      await done;
    } };
    pollers.set(key, entry);
    // a poller that died on its own (a token that was wrong at startup) must be startable
    // again by the next reload, so it leaves the map when its loop ends
    void done.finally(() => {
      if (pollers.get(key) === entry) pollers.delete(key);
      exitIfIdle();
    });
  };

  const stopPoller = async (key: string): Promise<void> => {
    const p = pollers.get(key);
    if (!p) return;
    await p.stop();
    if (pollers.get(key) === p) pollers.delete(key);
  };

  const readMail = (): void => {
    const next = loadMailConfig(root);
    if (next === null) {
      // empty or unreadable is a typo, not an instruction: a mailbox is not torn down by
      // a half-written file, and stopping one is a restart
      if (mailbox !== null) {
        log(`重载：mail.json 是空的或读不出来，继续用旧的 ${Object.keys(mailbox.cfg).length} 个地址`);
      }
      return;
    }
    if (mailbox === null) {
      log("重载：新出现了 mail.json，但信箱是启动时起的——重启才起得来");
      return;
    }
    mailbox.cfg = next;
    for (const line of describeConfig(mailbox.cfg)) log(`mail 重载：${line}`);
  };

  const doReload = async (): Promise<void> => {
    const next = readBots(root);
    if (Object.keys(next).length === 0) {
      log("重载：bots.json 是空的或读不出来，一个 bot 都没动");
    } else {
      const merged = mergeBots(bots, next);
      for (const line of merged.notes) log(line);
      const kept = merged.bots;
      const tokens = (b: Bots): Record<string, string> =>
        Object.fromEntries(Object.entries(b).map(([k, c]) => [k, c.token]));
      const plan = reloadPlan(tokens(bots), tokens(kept));
      // stop, swap, start: the new poller must read the new token, and the old one has to
      // be gone before it starts polling or Telegram answers 409 to both
      for (const key of plan.stop) await stopPoller(key);
      bots = kept;
      for (const key of plan.start) startPoller(key);
      log(`重载：bots ${Object.keys(kept).length} 个（起 ${plan.start.length} 停 ${plan.stop.length}）`);
      for (const [key, cfg] of Object.entries(kept)) {
        log(
          `重载 ${key}：${cfg.listen ? `listen=${cfg.listen} ` : ""}` +
            `allow=${cfg.allow === undefined ? "不限" : `${cfg.allow.length} 人`}` +
            ` home=${cfg.chat ?? chats[key]?.home ?? "未知"}`,
        );
      }
    }
    readMail();
  };

  const reload = (): Promise<void> => {
    if (reloading !== null) {
      reloadAgain = true;
      return reloading;
    }
    const pass = async (): Promise<void> => {
      do {
        reloadAgain = false;
        await doReload().catch((err: unknown) => log(`重载失败：${(err as Error).message}`));
      } while (reloadAgain);
    };
    reloading = pass().finally(() => {
      reloading = null;
      // a SIGHUP that landed between the last loop check and here must not be swallowed
      if (reloadAgain) {
        void reload();
        return;
      }
      // checked here and not inside doReload: there `reloading` is still set, so the guard
      // that protects the stop/start window would swallow a reload that emptied the table
      exitIfIdle();
    });
    return reloading;
  };
  // before anything is awaited: SIGHUP's default action is to kill the process, and a
  // reload arriving during startup would look exactly like a crash
  process.on("SIGHUP", () => {
    log("收到 SIGHUP：重读 bots.json 和 mail.json");
    void reload();
  });

  // "working on it" is worth 4 seconds of a person's patience at a time; the state is
  // deliberately in memory, because a gateway restart should just stop typing.
  const typedAt = new Map<string, number>();
  const TYPING_REFRESH_MS = 4_000;

  const showTyping = async (key: string): Promise<void> => {
    const p = instanceData(key);
    const cfg = bots[key];
    if (!p || !cfg) return;
    // intent.json exists exactly while a waking is in flight, and only then is anybody
    // waiting for an answer
    const intent = readJson<{ startedAt?: string } | null>(p.intent, null);
    if (intent === null) return;
    const since = Date.parse(intent.startedAt ?? "");
    if (Number.isFinite(since) && Date.now() - since > 30 * 60_000) return; // a dead cycle must not type forever
    const knock = newestKnock(peekInbox(p.inbox));
    if (!knock || typeof knock.chat !== "number") return;
    const last = typedAt.get(key) ?? 0;
    if (Date.now() - last < TYPING_REFRESH_MS) return;
    typedAt.set(key, Date.now());
    try {
      await sendTyping(cfg.token, knock.chat);
    } catch {
      // a status is not worth failing the sweep over
    }
  };

  // One count per outbox item, in memory on purpose: a restart is a fresh set of attempts.
  const sendFailures = new Map<string, number>();

  const sweep = async (): Promise<void> => {
    for (;;) {
      // read per pass: a reload may have added or removed a bot since the last one
      for (const key of Object.keys(bots)) {
        try {
          await showTyping(key);
        } catch {
          // ignore
        }
        const dir = key === "ops" ? outboxDir(join(root, "data", "_ops")) : outboxDir(join(root, "data", key));
        for (const item of readOutbox(dir)) {
          // An item may have no words left after a partial success but still owe a file.
          if (
            item.messages.length === 0 &&
            (item.files ?? []).length === 0 &&
            (item.attachments ?? []).length === 0
          ) {
            ackOutbox(dir, item.file);
            continue;
          }
          try {
            if (await deliver(key, item.messages, item.chat, item.files, item.replyTo, item.attachments, item.file)) {
              ackOutbox(dir, item.file);
              sendFailures.delete(item.file);
            }
          } catch (err) {
            // Left in the queue until the attempts run out: acknowledging here is what
            // made a two-second blip lose words for good.
            const { n, giveUp } = failedAttempt(sendFailures, item.file);
            if (!giveUp) continue;
            writeOps(
              ops,
              "gateway",
              `发给 ${key} 失败 ${n} 次，放弃了：${(err as Error).message}。那条消息在 outbox/sent/ 里，没送到。`,
            );
            ackOutbox(dir, item.file);
            sendFailures.delete(item.file);
          }
        }
      }
      await new Promise<void>((r) => setTimeout(r, 2_000));
    }
  };

  if (mailbox !== null) {
    // a mailbox is a second transport: a field missing here must not take Telegram down
    // with it, and it must not be quiet either — ops is the only place a person looks
    const broken = (why: string): void => {
      const line = `信箱没起来：${why}。telegram 照常。`;
      log(line);
      writeOps(ops, "gateway", line);
    };
    // readMailEnv refuses a malformed bind loudly; that refusal belongs in `broken`,
    // not in an exception that kills the long poll on its way out.
    let mailEnv: ReturnType<typeof readMailEnv> = null;
    let envProblem: string | null = null;
    try {
      mailEnv = readMailEnv(root);
    } catch (err) {
      envProblem = (err as Error).message;
    }
    if (mailEnv === null) {
      broken(envProblem ?? `有 ${join("secrets", "mail.json")} 但没有 token（secrets/mail.env 的 GENG_MAIL_TOKEN）`);
    } else {
      try {
        await startMailServer({ root, getCfg: () => mailbox.cfg, env: mailEnv, log });
        for (const line of describeConfig(mailbox.cfg)) log(`mail 上线：${line}`);
      } catch (err) {
        broken((err as Error).message);
      }
    }
  }

  void sweep();
  for (const key of Object.keys(bots)) startPoller(key);
  // the pollers come and go on reload, so what keeps this process alive is the promise
  // that never settles — not a list of loops captured at startup
  await new Promise<void>(() => {});
}
