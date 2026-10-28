import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer, type Server } from "node:http";
import { makePaths } from "./paths.ts";
import { parseEnvFile } from "./search.ts";
import { readJson, writeJson } from "./state.ts";

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

export function readMailEnv(root: string): MailEnv | null {
  const file = parseEnvFile(join(root, "secrets", "mail.env"));
  const token = process.env.GENG_MAIL_TOKEN ?? file.GENG_MAIL_TOKEN ?? "";
  if (token === "") return null;
  // loopback by default: the tunnel is the only thing that should reach it
  const bind = process.env.GENG_MAIL_BIND ?? file.GENG_MAIL_BIND ?? "127.0.0.1:8788";
  const [host, port] = bind.split(":");
  return { token, bind: { host: host || "127.0.0.1", port: Number(port ?? 8788) } };
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
    .replace(/&#(\d+);/g, (_all, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
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

const BODY_LIMIT = 200_000;
const ATTACHMENT_LIMIT = 5 * 1024 * 1024;
const ATTACHMENT_TOTAL = 10 * 1024 * 1024;

function fileName(id: string, name: string): string {
  const base = basename(name).replace(/[^\w.\-]+/g, "_").slice(-80);
  return `${id}-${base === "" ? "file" : base}`;
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
  const id = mailId(mail.messageId, `${mail.from}|${mail.date ?? ""}|${subject}`);
  const at = mail.date ?? new Date(nowMs).toISOString();

  const attachments: { kind: string; path?: string; note?: string; bytes?: number }[] = [];
  let budget = ATTACHMENT_TOTAL;
  for (const a of mail.attachments) {
    const name = fileName(id, a.name ?? "file");
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
      writeFileSync(join(paths.filesDir, name), stored);
      budget -= bytes;
      attachments.push({ kind: "document", path: `/files/${name}`, bytes });
    } catch (err) {
      attachments.push({ kind: "document", note: `没存下（${(err as Error).message}）`, bytes });
    }
  }

  writeJson(join(paths.mail, `${id}.json`), {
    id,
    text,
    from: mail.from,
    at,
    subject,
    ...(attachments.length === 0 ? {} : { attachments }),
  });
  return { ok: true, id, instance: account.instance };
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
  cfg: MailConfig;
  env: MailEnv;
  log: (line: string) => void;
}

/**
 * One route, on loopback, behind the tunnel. Everything it can do is "hand one mail to
 * the mailbox", so there is nothing to route.
 */
export async function startMailServer(o: MailServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
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
      size += chunk.length;
      if (size <= INGEST_MAX_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > INGEST_MAX_BYTES) {
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
        const result = accept(raw, o.cfg, o.root, o.log);
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
