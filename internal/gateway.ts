import { existsSync } from "node:fs";
import { join } from "node:path";
import { attentionActive, parseAttention } from "./attention.ts";
import { quoteFor, quotedOf } from "./quote.ts";
import { ExpectedError } from "./errors.ts";
import type { Paths } from "./paths.ts";
import { makePaths } from "./paths.ts";
import { appendSaid } from "./people.ts";
import { attachmentOf, hostPathForWorkPath, KIND_WORD, safeName } from "./attach.ts";
import { markSeen, newestKnock, peekInbox } from "./inbox.ts";
import { ensureGatewayDirs, ackOutbox, isMuted, outboxDir, readMutes, readOutbox, writeOps } from "./mute.ts";
import { loadPolicy } from "./policy.ts";
import { readJson, writeJson } from "./state.ts";
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
  type TgMessage,
  type TgUpdate,
} from "./telegram.ts";

export type RouteReason = "dm" | "mention" | "reply" | "listen" | "ambient" | "muted" | "skip";

export interface RouteInput {
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
): { id: number; label: string; home: boolean }[] {
  const chats = readChats(join(root, "data", "_gateway", "chats.json"))[key];
  if (!chats) return [];
  const home = chats.home;
  return Object.entries(chats.known ?? {}).map(([id, c]) => ({
    id: Number(id),
    label: c.kind === "private" ? `私聊${c.who ? ` ${c.who}` : ""}` : `群「${c.title ?? id}」`,
    home: Number(id) === home,
  }));
}

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const REPEAT_LIMIT = 10;
const PAUSE_MS = 10 * 60_000;

interface SendWatch {
  times: number[];
  texts: string[];
  pausedUntil: number;
}

export async function runGateway(o: GatewayOptions): Promise<void> {
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const root = o.root;
  const botsFile = join(root, "secrets", "bots.json");
  const bots = readJson<Record<string, BotConfig>>(botsFile, {});
  const keys = Object.keys(bots);
  if (keys.length === 0) {
    throw new ExpectedError(`没有 bot：先写 ${botsFile}（{ "<instance>": { "token": "..." } }）`);
  }

  const { ops } = ensureGatewayDirs(root);
  const chatsFile = join(root, "data", "_gateway", "chats.json");
  const offsetsFile = join(root, "data", "_gateway", "offsets.json");
  const chats = readChats(chatsFile);
  const offsets = readJson<Record<string, number>>(offsetsFile, {});
  const watch = new Map<string, SendWatch>();

  const watchFor = (key: string): SendWatch => {
    let w = watch.get(key);
    if (!w) {
      w = { times: [], texts: [], pausedUntil: 0 };
      watch.set(key, w);
    }
    return w;
  };

  /** Tripwires look only at shape — rate, length, repetition. Never at meaning. */
  const trip = (key: string, texts: string[]): string | null => {
    const w = watchFor(key);
    const now = Date.now();
    w.times = w.times.filter((t) => now - t < RATE_WINDOW_MS);
    w.times.push(now);
    for (const t of texts) {
      w.texts.push(t);
      if (w.texts.length > 40) w.texts.shift();
    }
    if (now < w.pausedUntil) return "paused";
    if (w.times.length > RATE_LIMIT) {
      w.pausedUntil = now + PAUSE_MS;
      writeOps(ops, "gateway", `${key} 在 1 分钟内要发 ${w.times.length} 条，暂停投递 10 分钟。消息没丢。`);
      return "rate";
    }
    const last = w.texts[w.texts.length - 1];
    if (last && w.texts.filter((t) => t === last).length >= REPEAT_LIMIT) {
      w.pausedUntil = now + PAUSE_MS;
      writeOps(ops, "gateway", `${key} 连续发了同一句话 ${REPEAT_LIMIT} 次，暂停投递 10 分钟。消息没丢。`);
      return "repeat";
    }
    return null;
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
  ): Promise<boolean> => {
    const cfg = bots[key];
    if (!cfg) return false;
    const mine = (chats[key] ??= { known: {} });
    // bots.json can pin the home; otherwise the first chat it ever heard from is home,
    // and a later group must be named explicitly to be spoken into
    const home = cfg.chat ?? mine.home;
    const chat = want ?? home;
    if (typeof chat !== "number") return false;
    if (want !== undefined && !mine.known?.[String(want)]) {
      writeOps(ops, "gateway", `${key} 要发给不认识的 chat ${want}，没发。`);
      return true; // acknowledged: retrying will never make it known
    }
    if (trip(key, texts)) return false;
    // a quote only means something inside the chat it came from; a mismatched one is
    // dropped rather than sent into the wrong conversation
    const reply = quoteFor(chat, replyTo);
    for (const text of texts) {
      if (reply === undefined) {
        await sendMessage(cfg.token, chat, text);
        continue;
      }
      try {
        await sendMessage(cfg.token, chat, text, undefined, reply);
      } catch {
        // a deleted message must not take the words down with it
        await sendMessage(cfg.token, chat, text);
      }
    }
    const p = instanceData(key);
    for (const given of files) {
      // the path came from inside the container, so it can be anything it likes: only
      // /work is its own, and only files that exist there are sent
      const host = hostPathForWorkPath(p?.workspace ?? "", given);
      if (host === null) {
        writeOps(ops, "gateway", `${key} 想发 ${given}，那不是 /work 里的文件，没发。`);
        continue;
      }
      await sendFile(cfg.token, chat, host);
    }
    if (p) {
      for (const text of texts) {
        appendSaid(p.data, chat, { at: new Date().toISOString(), dir: "out", text });
      }
    }
    return true;
  };

  const handleUpdate = async (key: string, me: BotIdentity, update: TgUpdate): Promise<void> => {
    const message = update.message;
    if (!message) return;
    // text, or a caption on an attachment; anything else still has to be accounted for
    const words = message.text ?? message.caption ?? "";
    const att = attachmentOf(message);
    if (words === "" && att === null) {
      log(`${key} ← 忽略（${message.sticker ? "sticker" : "没有文字也没有附件"}）`);
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

    const cfg = bots[key];
    if (!cfg) return;
    const listen = cfg.listen ?? "all";
    const mutes = readMutes(join(p.palimpsest, "mute.json"), Date.now());
    const attention = parseAttention(readJson(join(p.palimpsest, "attention.json"), null));
    const muted = isMuted(mutes, { chatId: message.chat.id, isDm: message.chat.type === "private" });

    const decision = route({
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

    // fetch first, so the message is never announced without the thing it came with
    if (att && att.fileId) {
      const name = safeName(message.chat.id, message.message_id, att.name ?? "file");
      const dest = join(p.filesDir, name);
      try {
        const filePath = await getFilePath(cfg.token, att.fileId);
        const bytes = await downloadFile(cfg.token, filePath, dest);
        att.path = `/files/${name}`;
        att.bytes = bytes;
      } catch (err) {
        writeOps(ops, "gateway", `${key} 的文件没取到：${(err as Error).message}`);
        att.note = "没取到";
      }
    }

    const dir = decision.high ? p.inbox : p.inboxLow;
    const quoted = quotedOf(message.chat.id, message.reply_to_message, nameOf);
    const id = `${message.chat.id}-${message.message_id}`;
    const at = new Date().toISOString();
    const file = join(dir, `${id}.json`);
    // a redelivered message (crash between handling and recording the offset) lands on
    // the same file: rewrite it, but do not log the same words twice
    const redelivered = existsSync(file);
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
      const said = words !== "" ? words : `[${att ? KIND_WORD[att.kind] : "空消息"}]`;
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

  const poll = async (key: string): Promise<void> => {
    const cfg = bots[key];
    if (!cfg) return;
    const me = await getMe(cfg.token);
    log(
      `${key} 上线：@${me.username}${cfg.listen ? ` listen=${cfg.listen}` : ""}` +
        ` home=${cfg.chat ?? chats[key]?.home ?? "未知"}`,
    );
    for (;;) {
      const updates = await getUpdates(cfg.token, offsets[key] ?? 0);
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

  const sweep = async (): Promise<void> => {
    for (;;) {
      for (const key of keys) {
        try {
          await showTyping(key);
        } catch {
          // ignore
        }
        const dir = key === "ops" ? outboxDir(join(root, "data", "_ops")) : outboxDir(join(root, "data", key));
        for (const item of readOutbox(dir)) {
          if (item.messages.length === 0) {
            ackOutbox(dir, item.file);
            continue;
          }
          try {
            if (await deliver(key, item.messages, item.chat, item.files, item.replyTo)) {
              ackOutbox(dir, item.file);
            }
          } catch (err) {
            writeOps(ops, "gateway", `发给 ${key} 失败：${(err as Error).message}`);
            ackOutbox(dir, item.file);
          }
        }
      }
      await new Promise<void>((r) => setTimeout(r, 2_000));
    }
  };

  void sweep();
  await Promise.all(keys.map((key) => poll(key)));
}
