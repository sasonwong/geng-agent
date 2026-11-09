import { randomBytes, randomUUID } from "node:crypto";

/**
 * The iLink wire. Every function here is about bytes on a socket: no inbox, no policy,
 * no transcript. The channel above it decides what a message means.
 *
 * The protocol is HTTP/JSON, not a WebSocket, and every reply carries a `context_token`
 * from the message being answered. There is no "open a conversation" call: without that
 * token the only honest answer is "wait for the owner to speak".
 */

const APP_ID = "bot";
const APP_VERSION = "132102";
const CLIENT_VERSION = "1.0.0";
const BOT_AGENT = "geng-agent/0.1.0";

export class WeixinError extends Error {
  override name = "WeixinError";
  readonly ret: number | null;
  readonly status: number | null;

  constructor(message: string, opts: { ret?: number; status?: number } = {}) {
    super(message);
    this.ret = opts.ret ?? null;
    this.status = opts.status ?? null;
  }
}

/** `-14` (or 401/403): the token is dead; no retry can fix it, only a new scan. */
export class WeixinSessionExpired extends WeixinError {
  override name = "WeixinSessionExpired";
  constructor(message: string, opts: { ret?: number; status?: number } = {}) {
    super(message, opts);
  }
}

export interface WeixinItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; encode_type?: number; playtime?: number };
  image_item?: { aeskey?: string; mid_size?: number };
  file_item?: { file_name?: string; len?: string };
  video_item?: { video_size?: number };
  ref_msg?: { title?: string; message_item?: WeixinItem };
}

export interface WeixinMessage {
  seq?: number;
  /** uint64: parsed as a string when the response gives it as a bare number. */
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: WeixinItem[];
}

export interface UpdatesResult {
  msgs: WeixinMessage[];
  /** The new opaque cursor; empty means "keep the one you have". */
  buf: string;
  /** The server's next long-poll window, when it said one. */
  timeoutMs: number;
}

export interface QrCode {
  qrcode: string;
  url: string;
}

export interface QrStatus {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

/** Every business body carries the same two words; the server uses them for compatibility. */
const BASE_INFO = { channel_version: CLIENT_VERSION, bot_agent: BOT_AGENT };

const LOSSLESS = new Set(["message_id", "msg_id", "svr_id"]);
const CTX = "context_token";

/**
 * `message_id` is a uint64. `JSON.parse` rounds it to a float, which changes the id and
 * makes a redelivered message look new; the reviver keeps the literal exactly as the
 * server wrote it. Only id-shaped numbers are touched: `seq`, timestamps and flags stay
 * numbers, because the rest of the file wants them that way.
 */
function parseBody(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && LOSSLESS.has(key) && context?.source !== undefined) {
      return context.source;
    }
    return value;
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WeixinError(`不是 JSON 对象：${text.slice(0, 200)}`);
  }
  return parsed as Record<string, unknown>;
}

function code(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/** A refusal the caller has to classify: -14 ends the session, -2 is "the context is not ready". */
function checkRet(body: Record<string, unknown>, what: string): void {
  const ret = code(body.ret);
  const errcode = code(body.errcode);
  // Either field may carry the refusal; a `ret: 0` beside `errcode: -14` is still expired.
  const bad = ret !== null && ret !== 0 ? ret : errcode !== null && errcode !== 0 ? errcode : 0;
  if (bad === 0) return;
  const detail = typeof body.errmsg === "string" ? `：${body.errmsg}` : "";
  const message = `${what} 返回 ${bad}${detail}`;
  if (bad === -14) throw new WeixinSessionExpired(message, { ret: bad });
  throw new WeixinError(message, { ret: bad });
}

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function timeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  auth?: boolean;
  baseInfo?: boolean;
}

/**
 * One authenticated POST. The `Content-Length` is the fetch implementation's job; the
 * three headers the server actually checks are spelled the same way on every call.
 */
async function post(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  opts: RequestOptions = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorizationtype: "ilink_bot_token",
    "x-wechat-uin": randomUin(),
    "ilink-app-id": APP_ID,
    "ilink-app-clientversion": APP_VERSION,
  };
  if (opts.auth !== false) headers.authorization = `Bearer ${token}`;
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? 20_000), ...(opts.signal ? [opts.signal] : [])];
  const response = await fetch(join(baseUrl, path), {
    method: "POST",
    headers,
    body: JSON.stringify(opts.baseInfo === false ? body : { ...body, base_info: BASE_INFO }),
    signal: AbortSignal.any(signals),
  });
  const text = await response.text();
  if (!response.ok) {
    const line = `${path} HTTP ${response.status}${text.trim() === "" ? "" : `：${text.slice(0, 200)}`}`;
    // A refused token is a session that has to be scanned again, not a transient 5xx.
    if (response.status === 401 || response.status === 403) {
      throw new WeixinSessionExpired(line, { status: response.status });
    }
    throw new WeixinError(line, { status: response.status });
  }
  return parseBody(text);
}

/** `getupdates` holds the connection for ~35s. A local timeout is an empty poll, not an error. */
export async function getUpdates(
  baseUrl: string,
  token: string,
  buf: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<UpdatesResult> {
  try {
    const body = await post(
      baseUrl,
      token,
      "/ilink/bot/getupdates",
      { get_updates_buf: buf },
      { signal, timeoutMs: timeoutMs + 15_000 },
    );
    checkRet(body, "getupdates");
    return {
      msgs: Array.isArray(body.msgs) ? (body.msgs as WeixinMessage[]) : [],
      buf: typeof body.get_updates_buf === "string" ? body.get_updates_buf : "",
      timeoutMs:
        typeof body.longpolling_timeout_ms === "number" && body.longpolling_timeout_ms > 0
          ? body.longpolling_timeout_ms
          : timeoutMs,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeoutError(err)) return { msgs: [], buf, timeoutMs };
    throw err;
  }
}

/**
 * One text bubble. `item_list` is one item on purpose: the documented stable path is one
 * item per request, and a failure then belongs to exactly one bubble.
 */
export async function sendText(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const body = await post(
    baseUrl,
    token,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `geng-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        [CTX]: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
    { signal, timeoutMs: 20_000 },
  );
  // The documented success body is empty; some deployments still put a ret in it.
  checkRet(body, "sendmessage");
}

export async function getConfig(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const body = await post(
    baseUrl,
    token,
    "/ilink/bot/getconfig",
    { ilink_user_id: userId, ...(contextToken === undefined ? {} : { [CTX]: contextToken }) },
    { signal, timeoutMs: 10_000 },
  );
  checkRet(body, "getconfig");
  return typeof body.typing_ticket === "string" ? body.typing_ticket : "";
}

export async function sendTyping(
  baseUrl: string,
  token: string,
  userId: string,
  ticket: string,
  status: 1 | 2,
  signal?: AbortSignal,
): Promise<void> {
  const body = await post(
    baseUrl,
    token,
    "/ilink/bot/sendtyping",
    { ilink_user_id: userId, typing_ticket: ticket, status },
    { signal, timeoutMs: 10_000 },
  );
  checkRet(body, "sendtyping");
}

/**
 * The login QR is the one request without a token. It still carries the UIN and the
 * no-auth `AuthorizationType`, and it must not send `base_info` or a Bearer header.
 *
 * `local_token_list` is capped at one: this instance's own token. Sending the host's
 * other tokens would let the server answer `binded_redirect` for a different bot and
 * kick it off its poller.
 */
export async function getQrCode(baseUrl: string, localTokens: string[], signal?: AbortSignal): Promise<QrCode> {
  const body = await post(
    baseUrl,
    "",
    "/ilink/bot/get_bot_qrcode?bot_type=3",
    { local_token_list: localTokens.filter((t) => t.trim() !== "").slice(0, 1) },
    { auth: false, baseInfo: false, signal, timeoutMs: 15_000 },
  );
  checkRet(body, "get_bot_qrcode");
  const qrcode = typeof body.qrcode === "string" ? body.qrcode : "";
  const url = typeof body.qrcode_img_content === "string" ? body.qrcode_img_content : "";
  if (qrcode === "") throw new WeixinError("get_bot_qrcode 没有给 qrcode");
  return { qrcode, url: url === "" ? qrcode : url };
}

/** Polls the scan; the server holds this for ~35s too, so a timeout is "still waiting". */
export async function getQrStatus(
  baseUrl: string,
  qrcode: string,
  verifyCode: string | undefined,
  signal?: AbortSignal,
): Promise<QrStatus> {
  const query = `qrcode=${encodeURIComponent(qrcode)}${verifyCode === undefined ? "" : `&verify_code=${encodeURIComponent(verifyCode)}`}`;
  const url = join(baseUrl, `/ilink/bot/get_qrcode_status?${query}`);
  try {
    const response = await fetch(url, {
      headers: {
        "ilink-app-id": APP_ID,
        "ilink-app-clientversion": APP_VERSION,
      },
      signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
    });
    const text = await response.text();
    if (!response.ok) throw new WeixinError(`get_qrcode_status HTTP ${response.status}：${text.slice(0, 200)}`);
    const body = parseBody(text);
    checkRet(body, "get_qrcode_status");
    return {
      status: typeof body.status === "string" ? body.status : "wait",
      ...(typeof body.bot_token === "string" ? { bot_token: body.bot_token } : {}),
      ...(typeof body.ilink_bot_id === "string" ? { ilink_bot_id: body.ilink_bot_id } : {}),
      ...(typeof body.ilink_user_id === "string" ? { ilink_user_id: body.ilink_user_id } : {}),
      ...(typeof body.baseurl === "string" ? { baseurl: body.baseurl } : {}),
      ...(typeof body.redirect_host === "string" ? { redirect_host: body.redirect_host } : {}),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeoutError(err)) return { status: "wait" };
    throw err;
  }
}
