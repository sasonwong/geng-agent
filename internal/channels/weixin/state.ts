import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readText } from "../../fs.ts";

/** The fixed host `get_bot_qrcode` starts from; a status redirect may move it. */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/**
 * One bot per instance. The file is host-only for the same reason `bots.json` is: a
 * container that can send is a container that can leak the owner's WeChat identity.
 *
 * `baseUrl` comes from the login answer and is stored with the token: a login that
 * moved to another IDC must not fall back to the old host on the next restart.
 */
export interface WeixinConfig {
  token: string;
  baseUrl?: string;
  botId?: string;
  /** The one WeChat user this bot may hear from and answer. */
  userId?: string;
  /** What the page calls the owner; the protocol does not carry a display name. */
  name?: string;
  /** Bumped by every successful login, so a same-token re-scan still restarts the poller. */
  savedAt?: string;
}

export interface WeixinState {
  /** Opaque `get_updates_buf`; an empty answer must not erase the last good one. */
  buf?: string;
  /** The reply anchor from the last inbound message; without it nothing can be sent. */
  contextToken?: string;
  /** When the owner last spoke; the reply window is counted from here. */
  lastInboundAt?: string;
  /** Bubbles sent since that message. The platform's real limit is a black box. */
  sentSinceInbound?: number;
  typingTicket?: string;
  /** When the ticket was fetched; it is reused for 24 hours. */
  typingAt?: string;
  /** Set after `-14`; the poller parks until a new login resets this entry. */
  expiredAt?: string;
  /** The credential generation this session belongs to; a new login resets the session. */
  savedAt?: string;
}

export type WeixinStates = Record<string, WeixinState>;

export interface WeixinFile {
  configs: Record<string, WeixinConfig>;
  problems: string[];
}

export function credentialsFile(root: string): string {
  return join(root, "secrets", "weixin.json");
}

export function stateFile(root: string): string {
  return join(root, "data", "_gateway", "weixin.json");
}

/** Atomic and 600: this is a bot token plus the owner's WeChat id. */
function writePrivate(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Parse the credentials file and keep the entries that still say something.
 *
 * A blank token is kept rather than dropped: `--check` has to be able to say "weixin/alice
 * has no token", and a file that is being edited is not a reason to stop a poller that is
 * already running (the reload's merge keeps the old token).
 */
export function readWeixin(root: string): WeixinFile {
  const file = credentialsFile(root);
  const raw = readText(file);
  if (raw === null) return { configs: {}, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { configs: {}, problems: [`${file} 不是合法 JSON`] };
  }
  if (!isRecord(parsed)) {
    return { configs: {}, problems: [`${file} 应该是「实例名 → 微信配置」的对象`] };
  }
  const configs: Record<string, WeixinConfig> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      problems.push(`${key}：微信配置应该是一个对象`);
      continue;
    }
    const token = text(value.token);
    if (value.token !== undefined && token === undefined) {
      problems.push(`${key}：token 是空的`);
    }
    configs[key] = {
      token: token ?? "",
      ...(text(value.baseUrl) === undefined ? {} : { baseUrl: text(value.baseUrl) as string }),
      ...(text(value.botId) === undefined ? {} : { botId: text(value.botId) as string }),
      ...(text(value.userId) === undefined ? {} : { userId: text(value.userId) as string }),
      ...(text(value.name) === undefined ? {} : { name: text(value.name) as string }),
      ...(text(value.savedAt) === undefined ? {} : { savedAt: text(value.savedAt) as string }),
    };
    if (token === undefined) problems.push(`${key}：没有 token，先 geng channels login weixin ${key}`);
    else if (text(value.userId) === undefined) problems.push(`${key}：没有 userId，重新扫码登录一次`);
  }
  return { configs, problems };
}

export function writeWeixin(root: string, configs: Record<string, WeixinConfig>): void {
  writePrivate(credentialsFile(root), configs);
}

/** Save one instance, leaving the others alone. */
export function saveWeixin(root: string, instance: string, cfg: WeixinConfig): void {
  const all = readWeixin(root).configs;
  all[instance] = cfg;
  writeWeixin(root, all);
}

/**
 * A half-written file must not stop a working poller: a missing token or owner keeps the
 * last known value. A brand-new entry with no token is dropped — there is nothing to poll
 * with, and a note says so.
 */
export function mergeWeixin(
  running: Record<string, WeixinConfig>,
  next: Record<string, WeixinConfig>,
): { configs: Record<string, WeixinConfig>; notes: string[] } {
  const configs: Record<string, WeixinConfig> = {};
  const notes: string[] = [];
  for (const [key, cfg] of Object.entries(next)) {
    const old = running[key];
    const token = cfg.token.trim() !== "" ? cfg.token : old?.token;
    if (token === undefined || token === "") {
      notes.push(`重载：${key} 没有 token，也没有旧的可用，跳过`);
      continue;
    }
    if (cfg.token.trim() === "" && old) notes.push(`重载：${key} 没有 token，沿用旧的`);
    const userId = (cfg.userId ?? "").trim() !== "" ? cfg.userId : old?.userId;
    if (userId === undefined && old !== undefined) notes.push(`重载：${key} 没有 userId，沿用旧的`);
    const baseUrl = (cfg.baseUrl ?? "").trim() !== "" ? cfg.baseUrl : old?.baseUrl;
    const botId = (cfg.botId ?? "").trim() !== "" ? cfg.botId : old?.botId;
    const name = (cfg.name ?? "").trim() !== "" ? cfg.name : old?.name;
    const savedAt = (cfg.savedAt ?? "").trim() !== "" ? cfg.savedAt : old?.savedAt;
    configs[key] = {
      token,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(botId === undefined ? {} : { botId }),
      ...(userId === undefined ? {} : { userId }),
      ...(name === undefined ? {} : { name }),
      ...(savedAt === undefined ? {} : { savedAt }),
    };
  }
  return { configs, notes };
}

/** The gateway's own state, keyed by instance; never mounted into the container. */
export function readState(root: string): WeixinStates {
  const raw = readText(stateFile(root));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const states: WeixinStates = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      states[key] = {
        ...(typeof value.buf === "string" ? { buf: value.buf } : {}),
        ...(typeof value.contextToken === "string" ? { contextToken: value.contextToken } : {}),
        ...(typeof value.lastInboundAt === "string" ? { lastInboundAt: value.lastInboundAt } : {}),
        ...(typeof value.sentSinceInbound === "number" ? { sentSinceInbound: value.sentSinceInbound } : {}),
        ...(typeof value.typingTicket === "string" ? { typingTicket: value.typingTicket } : {}),
        ...(typeof value.typingAt === "string" ? { typingAt: value.typingAt } : {}),
        ...(typeof value.expiredAt === "string" ? { expiredAt: value.expiredAt } : {}),
        ...(typeof value.savedAt === "string" ? { savedAt: value.savedAt } : {}),
      };
    }
    return states;
  } catch {
    return {};
  }
}

export function writeState(root: string, states: WeixinStates): void {
  writePrivate(stateFile(root), states);
}

/**
 * A WeChat id is a string, but the gateway's inbox is keyed by a number.
 *
 * The range is deliberately far below Telegram's: `-8e15 .. -8.1e15` stays inside
 * `Number.MAX_SAFE_INTEGER`, leaves `lastIndexOf("-")` in `parseInboxId` working, and
 * cannot collide with the `-100…` group ids Telegram hands out. Six hash bytes are
 * enough for 10^14 buckets; a collision would need the same owner id to hash twice.
 */
const CHAT_BASE = -8_000_000_000_000_000;
const CHAT_SPAN = 100_000_000_000_000;

export function chatIdFor(userId: string): number {
  const digest = createHash("sha256").update(userId).digest();
  const n = digest.readUIntBE(0, 6) % CHAT_SPAN;
  return CHAT_BASE - n;
}

/** The reply window and bubble budget are the platform's black box; these are its edges. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const BUBBLE_LIMIT = 10;
