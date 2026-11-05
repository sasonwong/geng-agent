import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { ATTENTION_MAX_MS } from "./attention.ts";
import { allocate, fileById } from "./ids.ts";
import { installationToken, readGhApp } from "./ghapp.ts";
import { proxyModel } from "./modelproxy.ts";
import { forwardPlain, handleConnect, type Chain, type ProxyRule } from "./proxy.ts";
import { keyCanMute, writeOps } from "./mute.ts";
import { parseReplyTo } from "./quote.ts";
import { openText, recallText } from "./recall.ts";
import { NEGOTIABLE } from "./proposal.ts";
import { parseAfter } from "./schedule.ts";
import { readJson, readText, writeJson, writeText } from "./fs.ts";

/**
 * The book endpoint: the only way into the book, because the book is not mounted.
 *
 * `/state`, `/mail`, `/people` and `/inbox` are all outside the container, so every read
 * and every write is a call the daemon can name and count — a `cat` used to leave no trace
 * at all. The same socket carries model traffic, the outbound proxy and git's credential
 * question: one channel into the host, and nothing goes the other way.
 *
 * Why a unix socket and not a port: the container does not need a network address to reach
 * a host process, and a port is reachable by everything on the bridge — which then needs a
 * token, and a firewall exception, to stay safe. The file is the boundary.
 *
 * Served by the daemon, but written as a library that takes `Paths`: the tool tests and
 * the dev commands run the same code, and a tool that only exists when systemd is around
 * would be a tool that fails exactly when someone is debugging.
 */
export const BOOK_SOCKET = "book.sock";

/** The path inside the container; the host side comes from `paths`. */
export const BOOK_SOCKET_IN_CONTAINER = "/run/geng/book.sock";

const MAX_BODY = 32 * 1024;
// A model request is a conversation plus tool schemas; a few megabytes is generous.
const MAX_MODEL_BODY = 32 * 1024 * 1024;

/**
 * A value for a test, a function for the daemon.
 *
 * Policy is re-read at the top of every cycle and a new chat is learned whenever somebody
 * adds the bot to a group, so anything derived from either is stale the moment it is read
 * once. The daemon passes a getter; a test passes a literal.
 */
type Live<T> = T | (() => T);

function at<T>(v: Live<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

export interface BookOptions {
  paths: Paths;
  log?: (line: string) => void;
  /** `policy.cycle.minWakeMinutes`, so an alarm can be told what it really became. */
  minWakeMs?: Live<number>;
  /** Which chats it may speak into or listen to; the daemon already knows, the container does not. */
  places?: Live<number[]>;
  /** Hosts the outbound proxy may reach. Absent means no proxy, which is what tests want. */
  proxy?: Live<ProxyRule>;
  /**
   * Called once per `/model` request. pi posts here for every model call, and the socket is
   * reachable from `bash` too: a count above the number of calls is that, and it is the
   * only way it shows up.
   */
  onModelRequest?: () => void;
  /** Called once per proxied connection: the only evidence that it went somewhere. */
  onNetwork?: (event: { target: string; ok: boolean; why?: string }) => void;
  /** How the daemon itself reaches the network: null for direct. */
  chain?: Live<Chain | null>;
}

export interface HandlerOptions {
  minWakeMs?: Live<number>;
  places?: Live<number[]>;
}

interface Reply {
  status: number;
  body: unknown;
}

function text(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function list(body: unknown, key: string): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return out.length === 0 ? null : out;
}

function integer(body: unknown, key: string): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function array(body: unknown, key: string): unknown[] | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function flatKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? flatKeys(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

/** Append to a file it may not have written yet, keeping whatever is already there. */
function appendText(file: string, addition: string): void {
  const before = readText(file) ?? "";
  const glue = before === "" || before.endsWith("\n") ? "" : "\n";
  writeText(file, `${before}${glue}${addition}\n`);
}

function parseWhen(when: string): number | null {
  const delta = parseAfter(when);
  if (delta !== null) return Date.now() + delta;
  const at = Date.parse(when);
  return Number.isNaN(at) ? null : at;
}

export function bookHandler(paths: Paths, o: HandlerOptions = {}) {
  return async (req: IncomingMessage, body: string): Promise<Reply> => {
    // per request, not per factory: see Live above
    const minWakeMs = at(o.minWakeMs ?? 0);
    const places = at(o.places ?? []);
    const route = req.url ?? "";
    let params: unknown = {};
    if (body.trim() !== "") {
      try {
        params = JSON.parse(body);
      } catch {
        return { status: 400, body: { error: "不是 JSON" } };
      }
    }
    const nowIso = new Date().toISOString();

    // journal: one id per text, content is whatever it wrote. The file name is the id,
    // the body is its own — that is the whole reason this can be a tool without the
    // daemon ever learning a format.
    if (route === "/journal") {
      const texts = list(params, "texts");
      if (texts === null) return { status: 400, body: { error: "texts 要是非空字符串数组" } };
      if (texts.length > 20) return { status: 400, body: { error: "一次最多 20 条" } };
      const out: string[] = [];
      for (const t of texts) {
        const { id } = allocate(paths, "journal");
        writeText(join(paths.journal, `${id}.md`), `${t.trim()}\n`);
        out.push(id);
      }
      return { status: 200, body: { ids: out, at: nowIso } };
    }

    if (route === "/discard") {
      const id = text(params, "id");
      if (id === null) return { status: 400, body: { error: "id 不能是空的" } };
      if (!/^J\d+-\d+$/.test(id.trim())) {
        return { status: 400, body: { error: `id 要写成 J20261104-3 这样，收到的是 ${id}` } };
      }
      const name = `${id.trim()}.md`;
      const from = join(paths.journal, name);
      if (!existsSync(from)) {
        // an entry can be written and discarded inside one round; saying which of the two
        // happened is the difference between a bug report and a no-op
        const gone = join(paths.journalDiscarded, name);
        if (existsSync(gone)) return { status: 200, body: { id: id.trim(), discarded: true, at: nowIso } };
        return { status: 404, body: { error: `没有 ${id} 这条：${name} 不在 journal/ 里` } };
      }
      const why = text(params, "why");
      if (why !== null) appendText(from, `\n[丢弃 ${nowIso}] ${why.trim()}`);
      // like a closed loop: moved, not deleted. The entry was written by someone, and the
      // book records that it happened even after it stops being true.
      mkdirSync(paths.journalDiscarded, { recursive: true });
      renameSync(from, join(paths.journalDiscarded, name));
      return { status: 200, body: { id: id.trim(), discarded: true, at: nowIso } };
    }

    if (route === "/loop/open") {
      const t = text(params, "text");
      if (t === null) return { status: 400, body: { error: "text 不能是空的" } };
      const { id } = allocate(paths, "loop");
      writeText(join(paths.openLoops, `${id}.md`), `${t.trim()}\n`);
      return { status: 200, body: { id, at: nowIso } };
    }

    if (route === "/loop/close") {
      const id = text(params, "id");
      if (id === null) return { status: 400, body: { error: "id 不能是空的" } };
      if (!/^L\d+$/.test(id.trim())) {
        return { status: 400, body: { error: `id 要写成 L12 这样，收到的是 ${id}` } };
      }
      const name = `${id.trim()}.md`;
      const from = join(paths.openLoops, name);
      if (!existsSync(from)) {
        return { status: 404, body: { error: `没有 ${id} 这件事：${name} 不在 open-loops/ 里` } };
      }
      const note = text(params, "note");
      if (note !== null) appendText(from, `\n[闭合 ${nowIso}] ${note.trim()}`);
      // Closing is a place to put it, not a deletion: the note stays readable, and the
      // count only follows files, so a subdirectory does not inflate it.
      const done = join(paths.openLoops, "closed");
      mkdirSync(done, { recursive: true });
      renameSync(from, join(done, name));
      return { status: 200, body: { id: id.trim(), closed: true, at: nowIso } };
    }

    // wait: the alarm, and the last writable file in /state once the mount is read-only.
    // Everything is normalised to an absolute moment on the way in — a relative one is
    // anchored to *now* here rather than to the file's mtime, so there is one reader of
    // "when" and the round that writes it is the round that says it.
    if (route === "/wait") {
      const when = text(params, "when");
      if (when === null) {
        return { status: 400, body: { error: 'when 不能是空的：写 "20m" 这样的一段时间，或者 2026-03-02T09:15:00Z 这样的时刻' } };
      }
      const atMs = parseWhen(when);
      if (atMs === null) {
        return { status: 400, body: { error: `看不懂 ${when}：写 "20m"、"2h"、"90s"，或者带时区的时刻` } };
      }
      // A past moment is a mistake with a timezone, not an instruction: waking in one
      // minute every round until it notices is a cheap way to burn a night.
      if (atMs < Date.now() - 60_000) {
        return { status: 400, body: { error: `那个时刻已经过去了：现在是 ${nowIso}` } };
      }
      const dueAtMs = Math.max(atMs, Date.now() + minWakeMs);
      const why = text(params, "why");
      writeJson(paths.waiting, { wake: { at: new Date(dueAtMs).toISOString() }, why });
      return { status: 200, body: { at: new Date(dueAtMs).toISOString(), why } };
    }

    // A mute is a state the gateway reads before it decides; the page shows it as state and
    // says out loud that it does not change delivery for a direct address.
    if (route === "/mute/set") {
      const target = text(params, "target")?.trim();
      if (target === undefined || !keyCanMute(target)) {
        return { status: 400, body: { error: `不认识的 target：只能是 "*" 或 "chat:<id>"（id 是数字）` } };
      }
      const minutes = integer(params, "minutes");
      if (minutes === null || minutes < 1 || minutes > 10080) {
        return { status: 400, body: { error: "minutes 要是 1 到 10080 之间的整数" } };
      }
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      const why = text(params, "why") ?? "";
      const current = readJson<Record<string, unknown>>(paths.mute, {});
      writeJson(paths.mute, { ...current, [target]: { until, why } });
      // A person who has just been silenced is the one reader of this line: it is a surprise
      // only they can explain, and the page (where the reason lives) is not theirs.
      writeOps(
        join(paths.root, "data", "_ops"),
        `mute@${paths.instance}`,
        `${target === "*" ? "所有群里的闲话" : target} 被静音到 ${until}${why === "" ? "" : `，理由：${why}`}。私聊、@ 和回复照样叫醒它。`,
      );
      return { status: 200, body: { target, until, why } };
    }

    if (route === "/attention/set") {
      const raw = array(params, "chats");
      if (raw === null) return { status: 400, body: { error: "chats 要是数组；空数组表示不听了" } };
      const chats: (number | "*")[] = [];
      for (const c of raw) {
        if (c === "*") {
          chats.push("*");
          continue;
        }
        const n = typeof c === "number" ? c : Number(String(c).trim());
        if (!Number.isFinite(n)) {
          return { status: 400, body: { error: `要写 chat 的 id 或 *，收到的是 ${JSON.stringify(c)}` } };
        }
        chats.push(n);
      }
      // no places configured is not "no chat may be heard": an instance without a bot
      // yet would otherwise refuse a listening window it has no reason to refuse.
      const strangers = places.length === 0 ? [] : chats.filter((c) => c !== "*" && !places.includes(c));
      if (strangers.length > 0) {
        return {
          status: 400,
          body: { error: `这些 chat 不在你能说话的地方里：${strangers.join("、")}。能听的是 ${places.join("、") || "（没有）"} 或 *` },
        };
      }
      if (chats.length === 0) {
        writeJson(paths.attention, {});
        return { status: 200, body: { chats: [], at: nowIso } };
      }
      // four hours is the most it may ask for: longer is not attention, it is a rule
      const untilParam = (params as Record<string, unknown>).until;
      const asked = untilParam === undefined ? null : Date.parse(String(untilParam));
      const wanted = asked === null || Number.isNaN(asked) ? Date.now() + ATTENTION_MAX_MS : asked;
      const untilMs = Math.min(wanted, Date.now() + ATTENTION_MAX_MS);
      if (untilMs <= Date.now()) {
        return { status: 400, body: { error: `那个时间已经过去了：${String(untilParam)}` } };
      }
      const until = new Date(untilMs).toISOString();
      const why = text(params, "why") ?? "";
      writeJson(paths.attention, { chats, until, why });
      return { status: 200, body: { chats, until, why } };
    }

    if (route === "/files/forget") {
      const wanted = list(params, "files");
      if (wanted === null) return { status: 400, body: { error: "files 要是非空字符串数组" } };
      // an id is what it has; the list keeps the `/files/...` form the pruner already reads
      const names = wanted.map((f) => {
        const hit = fileById(paths, f);
        return hit === null ? f : `/files/${hit.name}`;
      });
      const before = readJson<{ files?: unknown }>(paths.filesForget, {});
      const had = Array.isArray(before.files)
        ? before.files.filter((f): f is string => typeof f === "string")
        : [];
      const all = [...new Set([...had, ...names])];
      writeJson(paths.filesForget, { files: all });
      return { status: 200, body: { files: all, at: nowIso } };
    }

    if (route === "/proposal") {
      const value = (params as Record<string, unknown>).value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {
          status: 400,
          body: { error: 'value 要是一个对象，形如 {"cycle":{"defaultWakeMinutes":30}}' },
        };
      }
      writeJson(paths.proposal, value);
      const keys = flatKeys(value);
      // said now rather than found out next waking: a proposal for a value that is not on
      // the table is dropped when it is applied, and the reply can read the same list
      const willApply = keys.filter((k) => k in NEGOTIABLE);
      const ignored = keys.filter((k) => !(k in NEGOTIABLE));
      return { status: 200, body: { willApply, ignored, at: nowIso } };
    }

    // Reads: the container does not have the book any more, so this is the only way in
    // and every read leaves the same trace a write does.
    if (route === "/recall") {
      return { status: 200, body: { text: recallText(paths, params as Record<string, unknown>), at: nowIso } };
    }

    if (route === "/open") {
      const id = text(params, "id");
      if (id === null) return { status: 400, body: { error: "id 不能是空的：用 recall 看有哪些" } };
      const offset = integer(params, "offset") ?? 0;
      const r = openText(paths, id, Math.max(0, offset));
      return { status: r.found ? 200 : 404, body: r.found ? { text: r.text, at: nowIso } : { error: r.text } };
    }

    // say: the outbox is a queue the gateway drains with an ack, so the file stays exactly
    // what it was — only the writer moves to the host, and the container stops writing
    // anything but the page it calls its own.
    if (route === "/say") {
      const messages = list(params, "messages");
      if (messages === null) return { status: 400, body: { error: "messages 要是非空字符串数组" } };
      const replyTo = parseReplyTo((params as Record<string, unknown>).replyTo);
      if (replyTo === null) {
        return {
          status: 400,
          body: { error: 'replyTo 写那条消息的 id（形如 M-1001234567890-151 或 -1001234567890-151）' },
        };
      }
      const raw = (params as Record<string, unknown>).to;
      let chat: number | undefined;
      if (raw !== undefined && raw !== null) {
        // An empty string is a field the caller filled with nothing, not chat 0: Number("")
        // is 0, which is a number and therefore used to pass every check and become a
        // queue entry addressed to nowhere.
        const asked = typeof raw === "number" ? raw : String(raw).trim();
        if (asked !== "") {
          chat = Number(asked);
          if (!Number.isFinite(chat)) return { status: 400, body: { error: `to 要写 chat id（数字），收到的是 ${JSON.stringify(raw)}` } };
        }
      }
      // A quote names the conversation it belongs to, so it can stand in for `to`; with
      // neither, there is no default when there is more than one place — the fallback is
      // a guess about who it is talking to, and it has been wrong before.
      chat ??= replyTo?.chat;
      if (chat === undefined && places.length > 1) {
        return {
          status: 400,
          body: { error: `能说话的地方有 ${places.length} 处，要写 to：${places.join("、")}` },
        };
      }
      if (chat !== undefined && places.length > 0 && !places.includes(chat)) {
        return { status: 400, body: { error: `那个地方不在你能说话的地方里：${chat}。能发的是 ${places.join("、")}` } };
      }
      const files = list(params, "files") ?? [];
      // `F12` is an original the host already has; `/work/...` is something it made.
      // Two shapes, one field: the outbox keeps them apart so the gateway never has to
      // guess whether a string is a container path or a path on the host.
      const made: string[] = [];
      // what the gateway sends: a host path and the name to send it under. The id it was
      // asked for is not on the item — nothing reads it.
      const originals: { path: string; name: string }[] = [];
      for (const f of files) {
        if (f.startsWith("/")) {
          // Refused here rather than at the gateway: only /work is its own, and a path the
          // gateway would drop left the tool answering "带 1 个文件" over something that
          // never left the container.
          if (!f.startsWith("/work/") || f.includes("..")) {
            return { status: 400, body: { error: `只能发 /work 里的文件：${f}` } };
          }
          made.push(f);
          continue;
        }
        const hit = fileById(paths, f);
        if (hit === null) return { status: 404, body: { error: `没有这个文件：${f}` } };
        originals.push({ path: hit.path, name: hit.name });
      }
      // the file name is the id: a copy of it in the payload is a field with no reader
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(paths.outbox, { recursive: true });
      writeJson(join(paths.outbox, `${id}.json`), {
        messages,
        ...(chat === undefined ? {} : { chat }),
        ...(made.length === 0 ? {} : { files: made }),
        ...(originals.length === 0 ? {} : { attachments: originals }),
        ...(replyTo === undefined ? {} : { replyTo }),
      });
      return { status: 200, body: { id, count: messages.length, at: nowIso } };
    }

    return { status: 404, body: { error: `没有这个动作：${route}` } };
  };
}

export function socketPath(paths: Paths): string {
  return join(paths.run, BOOK_SOCKET);
}

export function startBookServer(o: BookOptions): Promise<Server> {
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const sock = socketPath(o.paths);
  const handle = bookHandler(o.paths, { minWakeMs: o.minWakeMs, places: o.places });

  // read per request: the operator edits policy.json and the daemon reloads it every cycle
  const rule = (): ProxyRule => (o.proxy === undefined ? { allow: [], cidrs: [] } : at(o.proxy));
  const chain = (): Chain | null => (o.chain === undefined ? null : at(o.chain));
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // A handler that throws would take the daemon down with it, and the round with the
    // daemon: every failure becomes an answer the agent can read instead.
    const guard = (err: unknown): void => {
      const why = err instanceof Error ? err.message : String(err);
      log(`book ${req.url ?? "?"} 出错：${why}`);
      // A proxied response that failed halfway has already sent its headers. Writing an
      // error over it throws ERR_HTTP_HEADERS_SENT, and an uncaught throw here takes the
      // daemon down in the middle of the round it was serving.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      reply(500, { error: `宿主那边出错了：${why}` });
    };
    // The one route that is not JSON: bytes go out as bytes. It is the only way a file
    // leaves the book, so `download` names a file by id and chooses where it lands.
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/files/")) {
      const wanted = decodeURIComponent(url.slice("/files/".length)).trim();
      const hit = fileById(o.paths, wanted);
      if (hit === null) {
        reply(404, { error: `没有这个文件：${wanted}` });
        return;
      }
      try {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(statSync(hit.path).size),
        });
        createReadStream(hit.path).pipe(res);
      } catch (err) {
        reply(500, { error: `读不出来：${(err as Error).message}` });
      }
      return;
    }
    // Model traffic comes through here, because the container has no key and must not
    // have one: it posts to /model/… and the daemon adds the credential and forwards. The
    // body is read whole (a request is JSON; a response is a stream, handled below).
    if (url === "/model" || url.startsWith("/model/")) {
      o.onModelRequest?.();
      const chunks: Buffer[] = [];
      let size = 0;
      // A destroyed socket with no answer is indistinguishable from a daemon that died, so
      // the refusal is written first; `refused` stops the body from growing after it, and
      // draining the rest lets the 413 reach the caller instead of being cut by an RST.
      let refused = false;
      req.on("data", (c: Buffer) => {
        if (refused) return;
        size += c.length;
        if (size > MAX_MODEL_BODY) {
          refused = true;
          chunks.length = 0;
          reply(413, { error: "请求体太大" });
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (refused) return;
        proxyModel(o.paths, req, res, Buffer.concat(chunks)).catch(guard);
      });
      req.on("error", guard);
      return;
    }
    // A proxy client names the whole URL in the request line. Without this the request
    // would fall through to the JSON routes and come back 405, which reads as "the proxy is
    // broken" in the middle of a container that has no other way out.
    if (/^http:\/\//i.test(url)) {
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on("data", (c: Buffer) => {
        if (refused) return;
        size += c.length;
        if (size > MAX_MODEL_BODY) {
          refused = true;
          chunks.length = 0;
          reply(413, { error: "请求体太大" });
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (refused) return;
        forwardPlain(req, res, Buffer.concat(chunks), rule(), chain(), (ok, why) =>
          o.onNetwork?.({ target: url, ok, why }),
        ).catch(guard);
      });
      req.on("error", guard);
      return;
    }
    // Plain text, not JSON, because the reader is `git`, not an agent: a credential helper
    // is a shell script that prints `username=…` / `password=…`. The token is minted here
    // and handed out once per git command, so nothing durable ever holds it.
    if (req.method === "GET" && url === "/gh/token") {
      const app = readGhApp(o.paths);
      if (app.app === null) {
        reply(503, { error: `没有配置 GitHub App：缺 ${app.missing.join("、")}` });
        return;
      }
      installationToken(app.app, Date.now())
        .then((t) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(t.token);
        })
        .catch(guard);
      return;
    }
    if (req.method !== "POST") {
      reply(405, { error: "只接受 POST" });
      return;
    }
    let body = "";
    let refused = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (refused) return;
      body += c;
      if (body.length > MAX_BODY) {
        refused = true;
        reply(413, { error: "请求体太大" });
        req.resume();
      }
    });
    req.on("end", () => {
      if (refused) return;
      handle(req, body).then((r) => reply(r.status, r.body)).catch(guard);
    });
    req.on("error", guard);
  });

  server.on("connect", (req, socket, head) => {
    const target = req.url ?? "";
    const report = (ok: boolean, why?: string): void => o.onNetwork?.({ target, ok, why });
    handleConnect(target, socket, head, rule(), log, chain(), report).catch((err: unknown) => {
      log(`proxy ${target} 出错：${(err as Error).message}`);
      report(false, (err as Error).message);
      socket.destroy();
    });
  });

  mkdirSync(o.paths.run, { recursive: true });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // A socket left behind by a killed daemon refuses connections and the error reads as
    // "the service is down", which is the one diagnosis that is never wrong and never
    // helpful. A live socket is held by a live process, so removing this one is safe.
    rmSync(sock, { force: true });
    server.listen(sock, () => {
      try {
        chmodSync(sock, 0o600);
      } catch {
        // a filesystem without modes is not a reason to stop serving
      }
      log(`book 端点 ${sock}`);
      resolve(server);
    });
  });
}

/** Whether the daemon should mount it: a missing file cannot be mounted. */
export function bookSocketExists(paths: Paths): boolean {
  try {
    return statSync(socketPath(paths)).isSocket();
  } catch {
    return false;
  }
}
