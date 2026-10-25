import { join } from "node:path";
import { ExpectedError } from "./errors.ts";
import type { Paths } from "./paths.ts";
import { makePaths } from "./paths.ts";
import { ensureGatewayDirs, ackOutbox, isMuted, outboxDir, readMutes, readOutbox, writeOps } from "./mute.ts";
import { loadPolicy } from "./policy.ts";
import { readJson, writeJson } from "./state.ts";
import {
  getMe,
  getUpdates,
  isMentioned,
  isReplyToBot,
  sendMessage,
  senderName,
  type BotConfig,
  type BotIdentity,
  type TgMessage,
  type TgUpdate,
} from "./telegram.ts";

export type RouteReason = "dm" | "mention" | "reply" | "ambient" | "muted" | "skip";

export interface RouteInput {
  isDm: boolean;
  isMention: boolean;
  isReply: boolean;
  listen: "all" | "mentions";
  muted: boolean;
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
  if (i.listen === "mentions") return { deliver: false, high: false, reason: "skip" };
  return { deliver: true, high: false, reason: i.muted ? "muted" : "ambient" };
}

export interface GatewayOptions {
  root: string;
  log?: (line: string) => void;
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
  const chats = readJson<Record<string, number>>(chatsFile, {});
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

  const deliver = async (key: string, texts: string[]): Promise<boolean> => {
    const cfg = bots[key];
    if (!cfg) return false;
    const chat = cfg.chat ?? chats[key];
    if (typeof chat !== "number") return false;
    if (trip(key, texts)) return false;
    for (const text of texts) await sendMessage(cfg.token, chat, text);
    return true;
  };

  const handleUpdate = async (key: string, me: BotIdentity, update: TgUpdate): Promise<void> => {
    const message = update.message;
    if (!message || !message.text) return;
    chats[key] = message.chat.id;
    writeJson(chatsFile, chats);

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
    const listen = cfg?.listen ?? "all";
    const mutes = readMutes(join(p.palimpsest, "mute.json"), Date.now());
    const muted = isMuted(mutes, { chatId: message.chat.id, isDm: message.chat.type === "private" });

    const decision = route({
      isDm: message.chat.type === "private",
      isMention: isMentioned(message, me),
      isReply: isReplyToBot(message, me),
      listen,
      muted: muted.muted,
    });

    if (!decision.deliver) return;

    const dir = decision.high ? p.inbox : p.inboxLow;
    const id = `${message.chat.id}-${message.message_id}`;
    writeJson(join(dir, `${id}.json`), {
      id,
      text: message.text,
      from: senderName(message),
      at: new Date().toISOString(),
      route: decision.reason,
    });
    log(`${key} ← ${decision.reason}${decision.high ? " (唤醒)" : ""}`);
  };

  const poll = async (key: string): Promise<void> => {
    const cfg = bots[key];
    if (!cfg) return;
    const me = await getMe(cfg.token);
    log(`${key} 上线：@${me.username}${cfg.listen ? ` listen=${cfg.listen}` : ""}`);
    for (;;) {
      const updates = await getUpdates(cfg.token, offsets[key] ?? 0);
      for (const update of updates) {
        offsets[key] = update.update_id + 1;
        writeJson(offsetsFile, offsets);
        try {
          await handleUpdate(key, me, update);
        } catch (err) {
          writeOps(ops, "gateway", `${key} 处理消息出错：${(err as Error).message}`);
        }
      }
    }
  };

  const sweep = async (): Promise<void> => {
    for (;;) {
      for (const key of keys) {
        const dir = key === "ops" ? outboxDir(join(root, "data", "_ops")) : outboxDir(join(root, "data", key));
        for (const item of readOutbox(dir)) {
          if (item.messages.length === 0) {
            ackOutbox(dir, item.file);
            continue;
          }
          try {
            if (await deliver(key, item.messages)) {
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
