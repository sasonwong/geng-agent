import { join } from "node:path";
import { readJson, writeJson } from "../fs.ts";
import { attachmentOf, placeholderFor, type Attachment } from "../attach.ts";
import { readBots, type Bots } from "../bots.ts";
import { quoteFor, quotedOf } from "../quote.ts";
import {
  downloadFile,
  getFilePath,
  getMe,
  getUpdates,
  isMentioned,
  isReplyToBot,
  nameOf,
  sendFile,
  sendMessage,
  sendTyping,
  senderName,
  type BotConfig,
  type BotIdentity,
  type TgMessage,
} from "../telegram.ts";
import {
  failedAttempt,
  HANDLE_ATTEMPTS,
  targetChat,
} from "./core.ts";
import type {
  Channel,
  Chats,
  Inbound,
  LoadResult,
  MergeResult,
  RemoteAttachment,
  SendContext,
  SendResult,
  StartContext,
  TypingContext,
} from "./channel.ts";

/** How long an empty poll waits before asking again: fast enough to notice, slow enough
 * not to spin. */
const POLL_PAUSE_MS = 3_000;

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
 * The offsets file is one map for every Telegram bot on this host. Two pollers that each
 * read it and wrote back their own copy would lose the other's last update; one object per
 * root is the same rule the old gateway had, only keyed by the root instead of a local.
 */
const offsetsByRoot = new Map<string, Record<string, number>>();
/** Same reason as the offsets: a reload is not a process restart, so neither is the count. */
const handleFailuresByRoot = new Map<string, Map<string, number>>();

function offsetsFor(root: string): Record<string, number> {
  const file = join(root, "data", "_gateway", "offsets.json");
  let offsets = offsetsByRoot.get(root);
  if (offsets === undefined) {
    offsets = readJson<Record<string, number>>(file, {});
    offsetsByRoot.set(root, offsets);
  }
  return offsets;
}

function offsetsFile(root: string): string {
  return join(root, "data", "_gateway", "offsets.json");
}

function failuresFor(root: string): Map<string, number> {
  let failures = handleFailuresByRoot.get(root);
  if (failures === undefined) {
    failures = new Map<string, number>();
    handleFailuresByRoot.set(root, failures);
  }
  return failures;
}

/** The channel only knows how to fetch it; the core owns the id and the name on disk. */
function remoteOf(att: Attachment | null, token: string): RemoteAttachment | null {
  if (att === null) return null;
  const { fileId, ...meta } = att;
  if (fileId === undefined) return meta;
  return {
    ...meta,
    download: async (dest: string): Promise<number> => {
      const filePath = await getFilePath(token, fileId);
      return downloadFile(token, filePath, dest);
    },
  };
}

function toInbound(message: TgMessage, me: BotIdentity, cfg: BotConfig): Inbound {
  const att = remoteOf(attachmentOf(message), cfg.token);
  const quote = quotedOf(message.chat.id, message.reply_to_message, nameOf) ?? undefined;
  const privateChat = message.chat.type === "private";
  return {
    channel: "telegram",
    nativeId: String(message.message_id),
    chat: message.chat.id,
    chatKind: privateChat ? "private" : "group",
    ...(privateChat ? {} : { chatTitle: message.chat.title ?? `chat ${message.chat.id}` }),
    who: senderName(message),
    fromId: String(message.from?.id ?? "?"),
    text: message.text ?? message.caption ?? "",
    at: new Date().toISOString(),
    allowed: !cfg.allow || cfg.allow.includes(message.from?.id ?? 0),
    isDm: privateChat,
    isMention: isMentioned(message, me),
    isReply: isReplyToBot(message, me),
    listen: cfg.listen ?? "all",
    homeRank: privateChat ? 2 : 0,
    ...(quote === undefined ? {} : { quote }),
    attachments: att === null ? [] : [att],
  };
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A pure whitelist, printed at startup because a wrong one is silent: too few and nobody
 * can wake it, one missing id and its conversation partner quietly stops reaching it.
 */
function allowLine(cfg: BotConfig): string {
  return cfg.allow === undefined
    ? "allow=不限"
    : cfg.allow.length === 0
      ? "allow=0（谁都进不来）"
      : `allow=${cfg.allow.length} 人`;
}

async function start(ctx: StartContext): Promise<void> {
  const initial = ctx.cfg() as BotConfig;
  const me = await getMe(initial.token);
  ctx.log(
    `${ctx.instance} 上线：@${me.username}${initial.listen ? ` listen=${initial.listen}` : ""} ${allowLine(initial)}` +
      ` home=${initial.chat ?? ctx.chats?.home ?? "未知"}`,
  );
  const offsets = offsetsFor(ctx.root);
  const file = offsetsFile(ctx.root);
  // One count per failing update, in memory on purpose: a process restart is a fresh set
  // of attempts, and the offsets file already says where the next start resumes from.
  const handleFailures = failuresFor(ctx.root);
  for (;;) {
    const updates = await getUpdates(initial.token, offsets[ctx.instance] ?? 0, undefined, ctx.signal);
    if (ctx.signal.aborted) return;
    if (updates.length === 0) {
      // An empty batch from a live long poll just waited 50 seconds; one from a
      // swallowed failure (a dropped connection, a 429) came back in milliseconds, and
      // without a pause the loop spins on a down network as fast as fetch can refuse.
      // The pause is abortable, so a reload does not wait it out.
      await wait(POLL_PAUSE_MS, ctx.signal);
      if (ctx.signal.aborted) return;
      continue;
    }
    for (const update of updates) {
      // Handle first, record the offset after: recording it first means a crash in
      // between loses the message for good, and Telegram will never hand it over again.
      // The same holds for a failed handling: the offset stays put, so the next poll
      // hands the update over again (redelivery is safe by design) — up to
      // HANDLE_ATTEMPTS, because a permanently broken update must not wedge the bot.
      let failure: Error | null = null;
      if (update.message !== undefined) {
        try {
          // allow/listen/chat are read per message: a reload swaps them under this poll
          await ctx.onInbound(toInbound(update.message, me, ctx.cfg() as BotConfig));
        } catch (err) {
          failure = err as Error;
        }
      }
      if (failure === null) {
        handleFailures.delete(`${ctx.instance}:${update.update_id}`);
      } else {
        const { n, giveUp } = failedAttempt(handleFailures, `${ctx.instance}:${update.update_id}`, HANDLE_ATTEMPTS);
        ctx.ops(`${ctx.instance} 处理消息出错（第 ${n} 次）：${failure.message}`);
        if (!giveUp) break; // offset not recorded: Telegram hands it over again
        ctx.ops(
          `${ctx.instance} 处理这条消息失败 ${n} 次，放弃了：${failure.message}。这条消息丢了，后面的照常。`,
        );
        handleFailures.delete(`${ctx.instance}:${update.update_id}`);
      }
      offsets[ctx.instance] = update.update_id + 1;
      writeJson(file, offsets);
    }
  }
}

async function send(ctx: SendContext): Promise<SendResult> {
  const cfg = ctx.cfg as BotConfig;
  // a quote only means something inside the chat it came from; a mismatched one is
  // dropped rather than sent into the wrong conversation
  const reply = quoteFor(ctx.chat, ctx.replyTo);
  let sent = 0;
  for (const text of ctx.item.messages) {
    let ids: number[] | undefined;
    try {
      ids = await sendMessage(cfg.token, ctx.chat, text, reply);
    } catch (first) {
      if (reply === undefined) {
        // The parts before this one already went out; `sent` says so, and the sweep
        // takes them out of the queue file instead of letting the retry say them twice.
        return { ack: false, sent, error: first as Error };
      }
      try {
        // a deleted message must not take the words down with it: once more without it
        ids = await sendMessage(cfg.token, ctx.chat, text);
      } catch (real) {
        return { ack: false, sent, error: real as Error };
      }
    }
    // A part that went out is a part that was said: recorded at the moment it left, so a
    // later failure in the same item cannot un-say it or double-say it on retry.
    ctx.onSent({
      text,
      // The id Telegram gave this part: `<chat>-<message_id>`, the same shape the
      // inbox uses, so a line of its own can be pointed at later just like anyone
      // else's. Absent only if the send answered without one.
      ...(ids[0] === undefined ? {} : { nativeId: String(ids[0]) }),
    });
    sent += 1;
  }
  for (const [i, step] of ctx.steps.entries()) {
    try {
      const sentFile = await sendFile(cfg.token, ctx.chat, step.path);
      // A file is a message: it takes its id before the words after it get theirs, so
      // the row has to be written here and not with the text. `at` is when the response
      // arrived — an upper bound on the id's instant, milliseconds away.
      ctx.onSent({
        text: placeholderFor([{ kind: sentFile.kind }]),
        ...(sentFile.id === undefined ? {} : { nativeId: String(sentFile.id) }),
      });
    } catch (err) {
      // all the words went out — `sent` covers them — so only the uploads are retried,
      // and only the ones that did not: `left` is what the queue file is rewritten to.
      const owed = ctx.steps.slice(i);
      return {
        ack: false,
        sent,
        error: err as Error,
        left: {
          files: owed.filter((s) => s.kind === "work").map((s) => s.given),
          attachments: owed.filter((s) => s.kind === "file").map((s) => ({ path: s.path, name: s.name })),
        },
      };
    }
  }
  return { ack: true, sent, error: null };
}

async function typing(ctx: TypingContext): Promise<void> {
  const cfg = ctx.cfg as BotConfig;
  await sendTyping(cfg.token, ctx.chat);
}

export const telegramChannel: Channel = {
  id: "telegram",
  textLimit: 4_000,
  load(root: string): LoadResult {
    return { configs: readBots(root), problems: [] };
  },
  merge(running, next): MergeResult {
    const merged = mergeBots(running as Bots, next as Record<string, Partial<BotConfig>>);
    return { configs: merged.bots, notes: merged.notes };
  },
  fingerprint(cfg: unknown): string {
    return (cfg as BotConfig).token;
  },
  defaultChat(cfg: unknown, chats: Chats | undefined): number | undefined {
    return targetChat(undefined, (cfg as BotConfig).chat, chats?.home) ?? undefined;
  },
  describe(_instance: string, cfg: unknown, chats: Chats | undefined): string {
    const c = cfg as BotConfig;
    return `${c.listen ? `listen=${c.listen} ` : ""}${allowLine(c)} home=${c.chat ?? chats?.home ?? "未知"}`;
  },
  start,
  send,
  typing,
  async check(cfg: unknown): Promise<string> {
    const c = cfg as BotConfig;
    // a blank token is a typo, not a 401 worth spending a request on
    if (c.token.trim() === "") throw new Error("没有 token");
    const me = await getMe(c.token);
    return `@${me.username}${c.chat ? `  chat=${c.chat}` : "  chat=未设（它给 bot 发第一条消息后自动记住）"}`;
  },
};
