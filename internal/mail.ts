import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { makePaths, type Paths } from "./paths.ts";
import { allocate, newFile } from "./ids.ts";
import { readEnvFile } from "./secret.ts";
import { mtimeMs, readJson, writeJson } from "./fs.ts";
import { ExpectedError } from "./errors.ts";

/**
 * Mail arrives from Cloudflare through a Worker, because a Worker is the only thing that
 * can read the MIME. Everything that decides whether a mail is wanted lives here, on the
 * host: the Worker is a dumb pipe with a token, so the rules stay in the repo and the
 * whitelist is one file the agent cannot read.
 *
 * Mail is pull, not push: a stranger with an envelope must not be able to start a
 * container, and the From header is the only identity there is — it is not authenticated
 * to us, so it decides who may *land in the mailbox*, never who may wake it.
 */

export interface MailAccount {
  /** Which instance's mailbox it is. */
  instance: string;
  /** Exact addresses that may write into it. Absent or empty: nobody. */
  allow?: string[];
}

export type MailConfig = Record<string, MailAccount>;

export interface MailEnv {
  token: string;
  bind: { host: string; port: number };
}

export function loadMailConfig(root: string): MailConfig | null {
  const raw = readJson<unknown>(join(root, "secrets", "mail.json"), null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: MailConfig = {};
  for (const [address, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const o = value as { instance?: unknown; allow?: unknown };
    if (typeof o.instance !== "string" || o.instance.trim() === "") continue;
    out[address.toLowerCase()] = {
      instance: o.instance,
      allow: Array.isArray(o.allow)
        ? o.allow.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase())
        : undefined,
    };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * `Number("")` is 0, and `listen(0)` asks the OS for a *random* port. A bind written as
 * `127.0.0.1:` or `127.0.0.1:http` used to start a perfectly healthy listener that the
 * tunnel (pointing at 8788) could never reach — mail simply stopped arriving, with no
 * error anywhere. A malformed bind is a typo the operator has to be told about.
 */
function parseBind(raw: string): { host: string; port: number } {
  const at = raw.lastIndexOf(":");
  if (at === -1) {
    throw new ExpectedError(`secrets/mail.env 的 GENG_MAIL_BIND 要写成 host:port，拿到 ${JSON.stringify(raw)}`);
  }
  const host = raw.slice(0, at).trim() || "127.0.0.1";
  const text = raw.slice(at + 1).trim();
  const port = Number(text);
  if (text === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ExpectedError(`secrets/mail.env 的 GENG_MAIL_BIND 端口要是 1-65535，拿到 ${JSON.stringify(text)}`);
  }
  return { host, port };
}

export function readMailEnv(root: string): MailEnv | null {
  const file = readEnvFile(join(root, "secrets", "mail.env"));
  // `||`, not `??`: an empty variable exported into the environment must not shadow a
  // good value in the file and quietly disable the mailbox.
  const token = process.env.GENG_MAIL_TOKEN || file.GENG_MAIL_TOKEN || "";
  if (token === "") return null;
  // loopback by default: the tunnel is the only thing that should reach it
  const bind = process.env.GENG_MAIL_BIND || file.GENG_MAIL_BIND || "127.0.0.1:8788";
  return { token, bind: parseBind(bind) };
}

/**
 * A mail can say `&#99999999;`, and a decoder that throws on it turns one bad character
 * into a 500, a bounce, and a mail that can never be received. Anything that is not a
 * writable code point is left exactly as it arrived.
 */
function decodeEntity(all: string, digits: string, radix: number): string {
  const n = Number.parseInt(digits, radix);
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return all;
  if (n >= 0xd800 && n <= 0xdfff) return all; // lone surrogates have no UTF-8 encoding
  return String.fromCodePoint(n);
}

/**
 * The body of a mail is a document, not sentences: block tags have to become line breaks
 * or the whole thing arrives as one paragraph with the words run together.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    // Outlook and friends emit numeric entities for quotes and dashes
    .replace(/&#(\d+);/g, (all, d: string) => decodeEntity(all, d, 10))
    .replace(/&#x([0-9a-f]+);/gi, (all, d: string) => decodeEntity(all, d, 16))
    // last, so a mail about "&amp;" is not decoded twice
    .replace(/&amp;/gi, "&")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Same Message-ID must land on the same file: Cloudflare may hand one mail over twice. */
export function mailId(messageId: string, fallback: string): string {
  const digest = createHash("sha1").update(messageId.trim() === "" ? fallback : messageId.trim());
  return `mail-${digest.digest("hex").slice(0, 12)}`;
}

export interface IngestAttachment {
  name?: string;
  mime?: string;
  bytes?: number;
  /** base64; absent when the Worker decided it was too big to carry */
  content?: string;
}

export interface Ingest {
  to: string;
  from: string;
  subject: string;
  messageId: string;
  date: string | null;
  text: string;
  html: string;
  attachments: IngestAttachment[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseIngest(raw: unknown): Ingest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const to = asString(o.to).trim();
  const from = asString(o.from).trim();
  if (to === "" || from === "") return null;
  const attachments = Array.isArray(o.attachments)
    ? o.attachments
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
        .map((a) => ({
          name: asString(a.name) || undefined,
          mime: asString(a.mime) || undefined,
          bytes: typeof a.bytes === "number" ? a.bytes : undefined,
          content: asString(a.content) || undefined,
        }))
    : [];
  const date = asString(o.date);
  return {
    to,
    from,
    subject: asString(o.subject),
    messageId: asString(o.messageId),
    date: Number.isFinite(Date.parse(date)) ? new Date(Date.parse(date)).toISOString() : null,
    text: asString(o.text),
    html: asString(o.html),
    attachments,
  };
}

export type Accepted =
  | { ok: true; id: string; instance: string }
  | { ok: false; reason: "bad" | "unknown" | "guest" };

// counting unread mail parses every file on the page of every waking, and /mail only
// grows: 32 KB is already a very long letter, and it bounds the cost at ~500 files
const BODY_LIMIT = 32_000;
const ATTACHMENT_LIMIT = 5 * 1024 * 1024;
const ATTACHMENT_TOTAL = 10 * 1024 * 1024;

/**
 * The id a mail keeps. The file name carries the message hash so a replay lands on the
 * same file, and the id is read back out of it rather than allocated twice — an id that
 * changed on a redelivery would leave the read list pointing at nothing.
 */
function mailNumber(paths: ReturnType<typeof makePaths>, hash: string): { id: string; file: string } {
  let names: string[] = [];
  try {
    names = readdirSync(paths.mail);
  } catch {
    names = [];
  }
  const existing = names.find((n) => n.endsWith(`-${hash}.json`));
  if (existing !== undefined) {
    const id = /^E\d+/.exec(existing)?.[0];
    if (id !== undefined) return { id, file: join(paths.mail, existing) };
  }
  const { id } = allocate(paths, "mail");
  return { id, file: join(paths.mail, `${id}-${hash}.json`) };
}

/**
 * Decide, then write. A mail that is not wanted must not touch the disk at all: the count
 * on the wake paper is a directory listing, so a dropped mail that left a file behind
 * would be a knock that never goes away.
 */
export function accept(
  raw: unknown,
  cfg: MailConfig,
  root: string,
  log: (line: string) => void,
  nowMs = Date.now(),
): Accepted {
  const mail = parseIngest(raw);
  if (!mail) return { ok: false, reason: "bad" };
  const account = cfg[mail.to.toLowerCase()];
  if (!account) {
    log(`mail ← 未知地址 ${mail.to}（没送）`);
    return { ok: false, reason: "unknown" };
  }
  let paths;
  try {
    paths = makePaths(root, account.instance);
  } catch {
    log(`mail ← ${account.instance} 不是合法的实例名（没送）`);
    return { ok: false, reason: "unknown" };
  }
  const allow = account.allow ?? [];
  if (!allow.includes(mail.from.toLowerCase())) {
    // printed because it is exactly what has to be pasted into secrets/mail.json, and a
    // wrong whitelist is silent in both directions
    log(`mail ← guest ${mail.from}（没送）`);
    return { ok: false, reason: "guest" };
  }

  const body = mail.text.trim() !== "" ? mail.text : htmlToText(mail.html);
  const subject = mail.subject.trim() === "" ? "（无主题）" : mail.subject.trim();
  const text = `${subject}\n\n${body.trim() === "" ? "（没有正文）" : body.trim()}`.slice(0, BODY_LIMIT);
  const hash = mailId(mail.messageId, `${mail.from}|${mail.date ?? ""}|${subject}`);
  const { id, file: mailFile } = mailNumber(paths, hash);
  // A replay lands on the same file, and the first copy is complete (`writeJson` writes and
  // renames). Rewriting it would allocate a fresh id for every attachment: the previous
  // files would stay on disk, counted by the cap and listed by `recall`, while the mail
  // pointed at copies — so one redelivery cost the same bytes twice.
  if (existsSync(mailFile)) return { ok: true, id, instance: account.instance };
  const at = mail.date ?? new Date(nowMs).toISOString();

  const attachments: { kind: string; id?: string; name?: string; note?: string; bytes?: number }[] = [];
  let budget = ATTACHMENT_TOTAL;
  for (const [index, a] of mail.attachments.entries()) {
    const original = a.name ?? "file";
    const stored = a.content === undefined ? null : Buffer.from(a.content, "base64");
    const bytes = stored === null ? undefined : stored.byteLength;
    if (stored === null || bytes === undefined) {
      attachments.push({ kind: "document", note: "太大没取", bytes: a.bytes });
      continue;
    }
    if (bytes > ATTACHMENT_LIMIT || bytes > budget) {
      attachments.push({ kind: "document", note: "太大没取", bytes });
      continue;
    }
    try {
      const { id: fileId, file } = newFile(paths, index, original);
      writeFileSync(file, stored);
      budget -= bytes;
      // the id, not a path: nothing is mounted, and `download`/`say` take the id
      attachments.push({ kind: "document", id: fileId, name: original, bytes });
    } catch (err) {
      attachments.push({ kind: "document", note: `没存下（${(err as Error).message}）`, bytes });
    }
  }

  writeJson(mailFile, {
    id,
    text,
    from: mail.from,
    at,
    subject,
    ...(attachments.length === 0 ? {} : { attachments }),
  });
  return { ok: true, id, instance: account.instance };
}

export interface PendingMail {
  count: number;
  senders: string[];
  oldestMs: number | null;
}

/**
 * Unread mail, aged by when it arrived — not by the Date header, which is the sender's
 * claim: one mail saying 1970 would pin "the oldest one has waited N days" forever.
 * The file's mtime is when this host stored it, and nothing writes these files again.
 */
export function pendingMail(p: Paths): PendingMail {
  let names: string[];
  try {
    names = readdirSync(p.mail).filter((f) => f.endsWith(".json"));
  } catch {
    return { count: 0, senders: [], oldestMs: null };
  }
  // its own file, so it can be hand-edited or truncated: anything unexpected means
  // "nothing is read" and the mailbox reappears on the page
  const raw = readJson<unknown>(p.mailRead, []);
  const read = new Set(
    Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [],
  );
  const senders = new Set<string>();
  const times: number[] = [];
  let count = 0;
  for (const name of names) {
    const file = join(p.mail, name);
    const one = readJson<{ id?: unknown; from?: unknown }>(file, {});
    const id = typeof one.id === "string" ? one.id : name.replace(/\.json$/, "");
    if (read.has(id)) continue;
    count++;
    if (typeof one.from === "string" && one.from !== "") senders.add(one.from);
    const at = mtimeMs(file);
    if (at !== null) times.push(at);
  }
  return {
    count,
    senders: [...senders].slice(0, 3),
    oldestMs: times.length === 0 ? null : Math.min(...times),
  };
}

/** A mailbox with nobody allowed is a typo, so the startup line must make it look like one. */
export function describeConfig(cfg: MailConfig): string[] {
  return Object.entries(cfg).map(([address, a]) => {
    const allow = a.allow ?? [];
    return `${address} → ${a.instance} allow=${allow.length === 0 ? "0（谁都进不来）" : `${allow.length} 人`}`;
  });
}

/** Cloudflare rejects anything bigger at SMTP, so the endpoint cannot be asked for more. */
export const INGEST_MAX_BYTES = 25 * 1024 * 1024;

export interface MailServerOptions {
  root: string;
  /** Read per mail, so editing secrets/mail.json does not need a gateway restart. */
  getCfg: () => MailConfig;
  env: MailEnv;
  log: (line: string) => void;
  /** Overridable so a test can prove the guard without sending 25 MB. */
  maxBytes?: number;
}

/**
 * One route, on loopback, behind the tunnel. Everything it can do is "hand one mail to
 * the mailbox", so there is nothing to route.
 */
export async function startMailServer(o: MailServerOptions): Promise<Server> {
  const maxBytes = o.maxBytes ?? INGEST_MAX_BYTES;
  const server = createServer((req, res) => {
    // 一个跑到一半断掉的上传（Worker 死了、容器里 curl --max-time 到了）会在 req 上抛
    // error；没有监听就是长驻网关里的未捕获异常，一封掉队的信能把所有 bot 的信箱一起带走。
    let failed = false;
    req.on("error", (err) => {
      failed = true;
      o.log(`mail ← 请求流断了：${(err as Error).message}`);
    });
    // 回信写到一半客户端没了，res 也会抛 error；这里只负责别让它变成未捕获异常。
    res.on("error", () => {});
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") {
      send(405, { ok: false, error: "POST only" });
      return;
    }
    if (req.headers["x-geng-token"] !== o.env.token) {
      o.log("mail ← token 不对（没送）");
      send(401, { ok: false, error: "bad token" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => {
      // 413 之后、或请求流已经断掉之后，绝不再把截断的 body 交给 accept()。
      if (failed) return;
      if (size > maxBytes) {
        send(413, { ok: false, error: "too big" });
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { ok: false, error: "bad json" });
        return;
      }
      try {
        const result = accept(raw, o.getCfg(), o.root, o.log);
        if (!result.ok) {
          // accepted and dropped: bouncing would tell a stranger the address exists, and
          // the mail is not wanted either way
          send(200, { ok: true, skipped: result.reason });
          return;
        }
        o.log(`mail ← ${result.instance} ${result.id}`);
        send(200, { ok: true, id: result.id });
      } catch (err) {
        // a write that failed must not be reported as delivered: let Cloudflare reject it
        o.log(`mail ← 收信出错：${(err as Error).message}`);
        send(500, { ok: false, error: "not stored" });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.env.bind.port, o.env.bind.host, () => resolve());
  });
  return server;
}
