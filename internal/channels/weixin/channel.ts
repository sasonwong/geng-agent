import { createHash } from "node:crypto";
import { failedAttempt, HANDLE_ATTEMPTS } from "../core.ts";
import { splitText as splitAt } from "../../text.ts";
import type {
  Channel,
  ChannelCheck,
  Chats,
  Inbound,
  LoadResult,
  MergeResult,
  RemoteAttachment,
  SendContext,
  SendResult,
  StartContext,
  TypingContext,
} from "../channel.ts";
import {
  getConfig,
  getUpdates,
  sendText,
  sendTyping,
  WeixinError,
  WeixinSessionExpired,
  type WeixinMessage,
} from "./client.ts";
import { loginWeixin } from "./login.ts";
import {
  BUBBLE_LIMIT,
  chatIdFor,
  credentialsFile,
  DEFAULT_BASE_URL,
  mergeWeixin,
  readState,
  readWeixin,
  WINDOW_MS,
  writeState,
  type WeixinConfig,
  type WeixinState,
  type WeixinStates,
} from "./state.ts";

const POLL_MS = 35_000;
const TEXT_LIMIT = 2_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const TYPING_TICKET_MS = 24 * 60 * 60 * 1000;

/**
 * One state object per root, shared by the poller and the sender. Two readers that each
 * load their own copy is how a send overwrites the context token a new message just
 * brought in, and how the 24-hour window is counted from a stale timestamp.
 */
const stateCache = new Map<string, WeixinStates>();

function statesFor(root: string): WeixinStates {
  let states = stateCache.get(root);
  if (states === undefined) {
    states = readState(root);
    stateCache.set(root, states);
  }
  return states;
}

function stateFor(root: string, instance: string): WeixinState {
  const states = statesFor(root);
  return (states[instance] ??= {});
}

/**
 * The poller reloads its own entry from disk, so a state written by a gateway restart is
 * seen. A new login is not this file's writer: the gateway owns `data/_gateway`, and the
 * credential's `savedAt` is what tells the start that the session has to begin again.
 */
function reloadState(root: string, instance: string): WeixinState {
  const states = statesFor(root);
  const fresh = readState(root);
  states[instance] = fresh[instance] ?? {};
  return states[instance];
}

function saveState(root: string, instance: string, state: WeixinState): void {
  const states = statesFor(root);
  states[instance] = state;
  writeState(root, states);
}

/**
 * A new scan is a new session: the old cursor belongs to a token that may no longer be
 * valid, and the old `context_token` cannot be used with a different login.
 */
function resetSession(state: WeixinState, savedAt: string | undefined): void {
  for (const key of ["buf", "contextToken", "lastInboundAt", "sentSinceInbound", "typingTicket", "typingAt", "expiredAt"] as const) {
    delete state[key];
  }
  if (savedAt !== undefined) state.savedAt = savedAt;
  else delete state.savedAt;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
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

/** The login answer may name a bare host; every request needs a scheme. */
function baseUrlOf(cfg: WeixinConfig): string {
  const raw = (cfg.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

function atOf(msg: WeixinMessage): string {
  const ms = msg.create_time_ms;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  return new Date().toISOString();
}

/**
 * The inbox file is `<chat>-<nativeId>`, so the id ends up in a filename. A server id is
 * normally digits, but `client_id` is free text: a `/` or `..` there must not become a
 * path. Anything that is not a short safe token is replaced by a hash of itself, which is
 * still stable across redelivery.
 */
function nativeIdOf(msg: WeixinMessage): string {
  const raw = String(msg.message_id ?? msg.client_id ?? msg.seq ?? "");
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(raw)) return raw;
  return createHash("sha256").update(raw === "" ? JSON.stringify(msg) : raw).digest("hex").slice(0, 32);
}

function textOf(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && typeof item.text_item?.text === "string") parts.push(item.text_item.text);
    else if (item.type === 3 && typeof item.voice_item?.text === "string" && item.voice_item.text.trim() !== "") {
      // WeChat sometimes ships a transcript beside the audio; using it is not "voice
      // support", it is free text the owner already sees on their phone.
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n").trim();
}

function mediaOf(msg: WeixinMessage): RemoteAttachment | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === 2) return { kind: "photo", note: "一期只收文字" };
    if (item.type === 4) {
      const name = item.file_item?.file_name;
      return { kind: "document", ...(name === undefined ? {} : { name }), note: "一期只收文字" };
    }
    if (item.type === 5) return { kind: "video", note: "一期只收文字" };
    if (item.type === 3) {
      const said = item.voice_item?.text;
      // The transcript is already the text; a later image is still the attachment.
      if (typeof said === "string" && said.trim() !== "") continue;
      return { kind: "voice", note: "没有转写" };
    }
  }
  return null;
}

function toInbound(msg: WeixinMessage, cfg: WeixinConfig, allowed: boolean): Inbound {
  const att = mediaOf(msg);
  return {
    channel: "weixin",
    channelLabel: "微信",
    nativeId: nativeIdOf(msg),
    chat: chatIdFor(msg.from_user_id ?? cfg.userId ?? ""),
    chatKind: "private",
    who: cfg.name ?? "主人",
    fromId: msg.from_user_id,
    text: textOf(msg),
    at: atOf(msg),
    allowed,
    isDm: true,
    isMention: false,
    isReply: false,
    listen: "all",
    // A private channel that can answer but cannot open a conversation ranks below
    // Telegram's private chats and above groups.
    homeRank: 1,
    canFile: false,
    canQuote: false,
    attachments: att === null ? [] : [att],
  };
}

/**
 * The channel's own limit. The gateway expands queued items to this size before it
 * calls `send`; this wrapper is still the fallback for a direct caller.
 */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  return splitAt(text, limit);
}

/**
 * How long a "can't send now" line waits before repeating. The sweep asks every two
 * seconds; the owner does not need the same fact 1,800 times an hour in `_ops`.
 */
const noticeAt = new Map<string, number>();
const NOTICE_EVERY_MS = 10 * 60_000;

function hold(ctx: SendContext, category: string, detail: string, sent = 0): SendResult {
  const key = `${ctx.instance}:${category}`;
  const now = Date.now();
  if ((noticeAt.get(key) ?? 0) + NOTICE_EVERY_MS <= now) {
    noticeAt.set(key, now);
    ctx.ops(`weixin/${ctx.instance} ${detail}；消息留在 outbox 里，等主人先说。`);
  }
  return { ack: false, sent, error: null, hold: true };
}

function expire(root: string, instance: string, state: WeixinState): void {
  state.expiredAt = new Date().toISOString();
  saveState(root, instance, state);
}

function untilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A parked poller keeps the gateway alive but silent; only a new scan (and a reload) wakes it. */
async function park(ctx: StartContext, why: string): Promise<void> {
  const line = `weixin/${ctx.instance} ${why}`;
  ctx.log(line);
  ctx.ops(line);
  await untilAbort(ctx.signal);
}

async function start(ctx: StartContext): Promise<void> {
  const initial = ctx.cfg() as WeixinConfig;
  if (initial.token.trim() === "" || initial.userId === undefined) {
    await park(ctx, "配置不完整（缺 token 或 userId）：geng channels login weixin <实例>");
    return;
  }
  const state = reloadState(ctx.root, ctx.instance);
  // `savedAt` is the credential generation. A re-scan (even one that reused the same
  // token) bumps it, and the old cursor/context must not be carried into the new session.
  if (state.savedAt !== initial.savedAt) {
    resetSession(state, initial.savedAt);
    saveState(ctx.root, ctx.instance, state);
  }
  if (state.expiredAt !== undefined) {
    await park(ctx, `会话过期了（${state.expiredAt}）：geng channels login weixin ${ctx.instance}`);
    return;
  }
  const base = baseUrlOf(initial);
  ctx.log(
    `weixin/${ctx.instance} 上线：${initial.botId ?? "bot"} 主人 ${initial.name ?? "主人"}` +
      ` home=${chatIdFor(initial.userId)} 只回文字`,
  );
  let buf = state.buf ?? "";
  let timeoutMs = POLL_MS;
  let backoff = 0;
  // Per-message handling failures, in memory: a process restart is a fresh set of attempts.
  const failures = new Map<string, number>();

  for (;;) {
    if (ctx.signal.aborted) return;
    let updates;
    try {
      updates = await getUpdates(base, initial.token, buf, timeoutMs, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) return;
      if (err instanceof WeixinSessionExpired) {
        expire(ctx.root, ctx.instance, state);
        await park(ctx, `会话过期（${(err as Error).message}）：geng channels login weixin ${ctx.instance}`);
        return;
      }
      backoff = backoff === 0 ? BACKOFF_MIN_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
      ctx.log(`weixin/${ctx.instance} 轮询失败：${(err as Error).message}；${Math.round(backoff / 1000)} 秒后再试`);
      await wait(backoff, ctx.signal);
      continue;
    }
    backoff = 0;
    // A successful poll is proof the session is alive; a send may have marked it expired
    // on a single -14 while the poll path recovered, and the queue should not stay parked.
    if (state.expiredAt !== undefined) {
      delete state.expiredAt;
      saveState(ctx.root, ctx.instance, state);
    }
    if (Number.isFinite(updates.timeoutMs) && updates.timeoutMs > 0) timeoutMs = updates.timeoutMs;
    let failed = false;
    for (const msg of updates.msgs) {
      if (ctx.signal.aborted) return;
      // Groups are not a supported place; a private bot that starts answering a group
      // would be a second audience nobody configured.
      if (typeof msg.group_id === "string" && msg.group_id !== "") {
        ctx.log(`weixin/${ctx.instance} ← 群消息（没送）`);
        continue;
      }
      if (msg.message_type !== 1) continue; // 2 is a bot echo, not a person
      const cfg = ctx.cfg() as WeixinConfig;
      const from = msg.from_user_id ?? "";
      const owner = cfg.userId !== undefined && from === cfg.userId;
      if (owner) {
        // The owner spoke: this is what opens the 24-hour window and resets the budget.
        // It is written before handling, because a message the route drops still counts
        // as the owner having spoken.
        if (typeof msg.context_token === "string" && msg.context_token.trim() !== "") {
          state.contextToken = msg.context_token;
        }
        state.lastInboundAt = atOf(msg);
        state.sentSinceInbound = 0;
        if (state.expiredAt !== undefined) delete state.expiredAt;
        saveState(ctx.root, ctx.instance, state);
      }
      try {
        // A guest reaches the core with allowed:false so the one place that logs guests
        // does it, with the id the operator needs to whitelist — WeChat has no allow list
        // of its own, only the single owner id from the scan.
        await ctx.onInbound(toInbound(msg, cfg, owner));
      } catch (err) {
        const key = `${ctx.instance}:${nativeIdOf(msg)}`;
        const { n, giveUp } = failedAttempt(failures, key, HANDLE_ATTEMPTS);
        ctx.ops(`weixin/${ctx.instance} 处理消息出错（第 ${n} 次）：${(err as Error).message}`);
        if (!giveUp) {
          failed = true;
          break;
        }
        ctx.ops(`weixin/${ctx.instance} 处理这条消息失败 ${n} 次，放弃了：${(err as Error).message}`);
        failures.delete(key);
      }
    }
    if (ctx.signal.aborted) return;
    // The cursor moves only after the batch was handled. A failure keeps the old buf so
    // the server hands the batch over again; the core's id dedupe makes that safe.
    if (!failed && updates.buf !== "") {
      buf = updates.buf;
      state.buf = buf;
    }
    saveState(ctx.root, ctx.instance, state);
  }
}

/**
 * Everything that decides "not now", shared by `ready` and `send`.
 *
 * `ready` answers the core before the tripwire records an attempt; `send` calls the same
 * function again because the window can close between the two. A held item is not a
 * failed send and must not burn a retry or a brake attempt.
 */
function blocked(ctx: SendContext, cfg: WeixinConfig, state: WeixinState): SendResult | null {
  if (cfg.token.trim() === "" || cfg.userId === undefined) {
    return hold(ctx, "配置", "配置不完整（缺 token 或 userId）");
  }
  if (state.expiredAt !== undefined) {
    return hold(ctx, "过期", `会话在 ${state.expiredAt} 过期了，重新扫码后才能发`);
  }
  if (ctx.chat !== chatIdFor(cfg.userId)) {
    ctx.ops(`weixin/${ctx.instance} 要发到 chat ${ctx.chat}，不是这个微信主人的会话，没发。`);
    return { ack: true, sent: 0, error: null };
  }
  if (ctx.item.messages.length === 0) return null;
  const contextToken = state.contextToken;
  if (contextToken === undefined || contextToken.trim() === "") {
    return hold(ctx, "no-context", "还没有主人发来的 context_token");
  }
  const last = Date.parse(state.lastInboundAt ?? "");
  if (!Number.isFinite(last) || Date.now() - last > WINDOW_MS || Date.now() < last - 60_000) {
    return hold(ctx, "window", "24 小时回复窗口关了");
  }
  const sentAlready = state.sentSinceInbound ?? 0;
  const bubbles = ctx.item.messages.reduce((n, text) => n + splitText(text).length, 0);
  if (sentAlready + bubbles > BUBBLE_LIMIT) {
    return hold(ctx, "budget", `这一轮只剩 ${Math.max(0, BUBBLE_LIMIT - sentAlready)} 条，这条要 ${bubbles} 条`);
  }
  return null;
}

async function send(ctx: SendContext): Promise<SendResult> {
  const cfg = ctx.cfg as WeixinConfig;
  const state = stateFor(ctx.root, ctx.instance);
  const stop = blocked(ctx, cfg, state);
  if (stop !== null) return stop;
  // Phase 1 carries text only. The book refuses files/quotes before queueing, so this
  // path is a legacy item; say it in ops and do not lose the words beside it.
  if (ctx.steps.length > 0) {
    ctx.ops(`weixin/${ctx.instance} 的通道只能发文字，${ctx.steps.length} 个附件没发。`);
  }
  if (ctx.replyTo !== undefined) {
    ctx.ops(`weixin/${ctx.instance} 的通道不支持引用回复，这条按普通消息发了。`);
  }
  if (ctx.item.messages.length === 0) return { ack: true, sent: 0, error: null };
  // `blocked` proved both of these for a non-empty item; re-read the token locally so a
  // later state change cannot turn the context of an in-flight send into `undefined`.
  const contextToken = state.contextToken as string;

  let sent = 0;
  for (const text of ctx.item.messages) {
    const parts = splitText(text);
    for (const part of parts) {
      try {
        await sendText(baseUrlOf(cfg), cfg.token, cfg.userId as string, part, contextToken);
      } catch (err) {
        if (err instanceof WeixinSessionExpired) {
          expire(ctx.root, ctx.instance, state);
          ctx.ops(`weixin/${ctx.instance} 会话过期：${(err as Error).message}。重新扫码后才能再发。`);
          return { ack: false, sent, error: err as Error, hold: true };
        }
        if (err instanceof WeixinError && err.ret === -2) {
          // The context token is not usable right now. A new inbound message brings a new
          // one; retrying the same token in two seconds cannot.
          return hold(ctx, "prepare", "sendmessage 说上下文还没准备好（ret=-2）", sent);
        }
        // shortcut: a direct caller, or an item written before the gateway split, can still
        // hand a >limit element; queued items reach this function as single bubbles.
        return { ack: false, sent, error: err as Error };
      }
      // Count each bubble as it leaves: the platform's quota is a black box, and a crash
      // between sending and recording it is the only way to undercount.
      state.sentSinceInbound = (state.sentSinceInbound ?? 0) + 1;
      saveState(ctx.root, ctx.instance, state);
    }
    // One transcript line for one `say` element, after all its bubbles are out. A mid-
    // element failure leaves it out of `sent`, so the retry says the whole element again.
    ctx.onSent({ text });
    sent += 1;
  }
  // The waking was typing; the reply is out, so clear the indicator. A status is not a
  // send: a failure here must not turn a delivered message into a retry.
  if (state.typingTicket !== undefined) {
    try {
      await sendTyping(baseUrlOf(cfg), cfg.token, cfg.userId as string, state.typingTicket, 2);
    } catch {
      // best effort
    }
  }
  return { ack: true, sent, error: null };
}

/** The typing ticket is a separate RPC. Its failure is not an auth failure, and a
 * missing "typing…" bubble is never worth failing a send over. */
function typingUnavailable(err: unknown): boolean {
  return err instanceof WeixinError && (err.ret === -2 || err.ret === -4);
}

async function typing(ctx: TypingContext): Promise<void> {
  const cfg = ctx.cfg as WeixinConfig;
  if (cfg.token.trim() === "" || cfg.userId === undefined) return;
  const state = stateFor(ctx.root, ctx.instance);
  if (state.contextToken === undefined || state.expiredAt !== undefined) return;
  let ticket = state.typingTicket;
  const fetched = Date.parse(state.typingAt ?? "");
  if (ticket === undefined || !Number.isFinite(fetched) || Date.now() - fetched > TYPING_TICKET_MS) {
    try {
      ticket = await getConfig(baseUrlOf(cfg), cfg.token, cfg.userId, state.contextToken);
    } catch (err) {
      if (typingUnavailable(err)) return;
      throw err;
    }
    if (ticket === "") return;
    state.typingTicket = ticket;
    state.typingAt = new Date().toISOString();
    saveState(ctx.root, ctx.instance, state);
  }
  try {
    await sendTyping(baseUrlOf(cfg), cfg.token, cfg.userId, ticket, 1);
  } catch (err) {
    if (!typingUnavailable(err)) throw err;
  }
}

function doctor(root: string, instance: string): ChannelCheck[] {
  const { configs, problems } = readWeixin(root);
  const cfg = configs[instance];
  // A file that cannot be read is the whole channel's problem, not a per-entry one.
  const fileWide = problems.filter((p) => p.startsWith(credentialsFile(root)));
  if (cfg === undefined) {
    return fileWide.length === 0
      ? [] // not configured is not a finding for every instance
      : [{ name: "微信配置", ok: false, detail: fileWide[0] as string }];
  }
  const checks: ChannelCheck[] = [];
  const token = cfg.token.trim();
  const own = problems.filter((p) => p.startsWith(`${instance}：`));
  if (token === "" || cfg.userId === undefined) {
    checks.push({
      name: "微信凭据",
      ok: false,
      detail: token === "" ? `没有 token：geng channels login weixin ${instance}` : "没有 userId：重新扫码登录",
    });
  } else {
    checks.push({ name: "微信凭据", ok: true, detail: `${cfg.botId ?? "bot"} 主人=${cfg.name ?? "主人"}` });
  }
  for (const problem of [...fileWide, ...own]) checks.push({ name: "微信配置", ok: false, detail: problem });
  const otherTokens = Object.entries(configs)
    .filter(([key, c]) => key !== instance && token !== "" && c.token === token)
    .map(([key]) => key);
  const otherUsers = Object.entries(configs)
    .filter(([key, c]) => key !== instance && cfg.userId !== undefined && c.userId === cfg.userId)
    .map(([key]) => key);
  if (otherTokens.length > 0 || otherUsers.length > 0) {
    checks.push({
      name: "微信重复绑定",
      ok: false,
      detail: [
        otherTokens.length === 0 ? "" : `token 和 ${otherTokens.join("、")} 相同：一个 bot 只能有一个消费者`,
        otherUsers.length === 0 ? "" : `主人 id 和 ${otherUsers.join("、")} 相同：一个微信只能绑一个 bot`,
      ]
        .filter((x) => x !== "")
        .join("；"),
    });
  }
  const state = readState(root)[instance] ?? {};
  if (state.expiredAt !== undefined) {
    checks.push({
      name: "微信会话",
      ok: false,
      detail: `在 ${state.expiredAt} 过期了：geng channels login weixin ${instance}，然后 reload 网关`,
    });
  } else if (state.lastInboundAt === undefined) {
    checks.push({ name: "微信会话", ok: true, warnOnly: true, detail: "还没收到过消息：只能等主人先说" });
  } else {
    const age = Date.now() - Date.parse(state.lastInboundAt);
    const used = state.sentSinceInbound ?? 0;
    if (!Number.isFinite(age) || age > WINDOW_MS) {
      checks.push({ name: "微信会话", ok: true, warnOnly: true, detail: "24 小时窗口关了：等主人先说" });
    } else if (used >= BUBBLE_LIMIT) {
      checks.push({ name: "微信会话", ok: true, warnOnly: true, detail: `这一轮的 ${BUBBLE_LIMIT} 条用完了：等主人先说` });
    } else {
      checks.push({ name: "微信会话", ok: true, detail: `窗口开着，还能发 ${BUBBLE_LIMIT - used} 条` });
    }
  }
  return checks;
}

export const weixinChannel: Channel = {
  id: "weixin",
  textLimit: TEXT_LIMIT,
  load(root: string): LoadResult {
    const file = readWeixin(root);
    return { configs: file.configs, problems: file.problems };
  },
  merge(running, next): MergeResult {
    const merged = mergeWeixin(
      running as Record<string, WeixinConfig>,
      next as Record<string, WeixinConfig>,
    );
    return { configs: merged.configs, notes: merged.notes };
  },
  fingerprint(cfg: unknown): string {
    const c = cfg as WeixinConfig;
    return `${c.token}\n${c.baseUrl ?? ""}\n${c.userId ?? ""}\n${c.savedAt ?? ""}`;
  },
  defaultChat(cfg: unknown, _chats: Chats | undefined): number | undefined {
    const c = cfg as WeixinConfig;
    return c.userId === undefined ? undefined : chatIdFor(c.userId);
  },
  describe(_instance: string, cfg: unknown): string {
    const c = cfg as WeixinConfig;
    return `微信 ${c.botId ?? "?"} 主人 ${c.name ?? "主人"}（只回文字）`;
  },
  start,
  ready(ctx): SendResult | null {
    return blocked(ctx, ctx.cfg as WeixinConfig, stateFor(ctx.root, ctx.instance));
  },
  send,
  typing,
  async check(cfg: unknown): Promise<string> {
    const c = cfg as WeixinConfig;
    if (c.token.trim() === "") throw new Error("没有 token");
    if (c.userId === undefined) throw new Error("没有 userId：先扫码登录");
    let typing = "";
    try {
      await getConfig(baseUrlOf(c), c.token, c.userId, undefined);
    } catch (err) {
      // -2 is "no context token yet"; -4 is the typing RPC failing. Both mean the
      // credential was accepted; neither is a reason to call the token bad.
      if (!typingUnavailable(err)) throw err;
      typing = "（typing 不可用）";
    }
    return `${c.botId ?? "bot"} 主人=${c.name ?? "主人"}${c.baseUrl === undefined ? "" : `  ${c.baseUrl}`}${typing}`;
  },
  doctor,
  async login(ctx): Promise<void> {
    await loginWeixin(ctx);
  },
};
