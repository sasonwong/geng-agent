import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { ATTENTION_MAX_MS } from "./attention.ts";
import { allocate, fileById } from "./ids.ts";
import { keyCanMute } from "./mute.ts";
import { openText, recallText } from "./recall.ts";
import { NEGOTIABLE } from "./proposal.ts";
import { parseAfter } from "./schedule.ts";
import { readJson, readText, writeJson, writeText } from "./state.ts";

/**
 * The book endpoint: the only way into `/state` once the container's mount is read-only.
 *
 * It exists for one reason the file system cannot give: a write has to leave a name. A
 * round that appends three journal entries and one that runs `ls` three times produce the
 * same `tools=3` today, so nothing the daemon counts can tell work from motion.
 *
 * Why a unix socket and not a port: the container does not need a network address to reach
 * a host process, and a port is reachable by everything on the bridge — which then needs a
 * token, and an exception in the egress rules, to stay safe. The file is the boundary.
 *
 * Served by the daemon, but written as a library that takes `Paths`: `runner: "local"` and
 * the dev commands run the same code, and a tool that only exists when systemd is around
 * would be a tool that fails exactly when someone is debugging.
 */
export const BOOK_SOCKET = "book.sock";

/** The path inside the container; the host side comes from `paths`. */
export const BOOK_SOCKET_IN_CONTAINER = "/run/geng/book.sock";

const MAX_BODY = 32 * 1024;

export interface BookOptions {
  paths: Paths;
  log?: (line: string) => void;
  /** `policy.cycle.minWakeMinutes`, so an alarm can be told what it really became. */
  minWakeMs?: number;
  /** Which chats it may speak into or listen to; the daemon already knows, the container does not. */
  places?: number[];
}

export interface HandlerOptions {
  minWakeMs?: number;
  places?: number[];
}

interface Reply {
  status: number;
  body: unknown;
}

function today(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/** The highest number already used in these directories, or 0. */
function highest(dirs: string[], pattern: RegExp): number {
  let max = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = pattern.exec(name);
      if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]) || 0);
    }
  }
  return max;
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

function parseReplyTo(raw: unknown): { chat: number; messageId: number } | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return null;
  const o = raw as { chat?: unknown; messageId?: unknown };
  if (typeof o.chat !== "number" || typeof o.messageId !== "number") return null;
  return { chat: o.chat, messageId: o.messageId };
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
  const minWakeMs = o.minWakeMs ?? 0;
  const places = o.places ?? [];
  return async (req: IncomingMessage, body: string): Promise<Reply> => {
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

    // mail/read: the one write a read is allowed to cause. /state is a mount the container
    // may not write once it is read-only, and the list of what has been opened is part of
    // the agent's own book — so the host keeps it, and `open` is what adds to it.
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
      writeJson(paths.attention, { chats, until, why, at: nowIso });
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
      writeJson(paths.filesForget, { files: all, at: nowIso });
      return { status: 200, body: { files: all, pending: wanted.length, at: nowIso } };
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
      const raw = (params as Record<string, unknown>).to;
      let chat: number | undefined;
      if (raw !== undefined && raw !== null) {
        chat = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(chat)) return { status: 400, body: { error: `to 要写 chat id（数字），收到的是 ${JSON.stringify(raw)}` } };
        if (places.length > 0 && !places.includes(chat)) {
          return { status: 400, body: { error: `那个地方不在你能说话的地方里：${chat}。能发的是 ${places.join("、")}` } };
        }
      }
      const files = list(params, "files") ?? [];
      // `F12` is an original the host already has; `/work/...` is something it made.
      // Two shapes, one field: the outbox keeps them apart so the gateway never has to
      // guess whether a string is a container path or a path on the host.
      const made: string[] = [];
      const originals: { id: string; path: string; name: string }[] = [];
      for (const f of files) {
        if (f.startsWith("/")) {
          made.push(f);
          continue;
        }
        const hit = fileById(paths, f);
        if (hit === null) return { status: 404, body: { error: `没有这个文件：${f}` } };
        originals.push({ id: f, path: hit.path, name: hit.name });
      }
      const replyTo = parseReplyTo((params as Record<string, unknown>).replyTo);
      if (replyTo === null) {
        return { status: 400, body: { error: 'replyTo 要写成 {"chat":-1001234567890,"messageId":151}' } };
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(paths.outbox, { recursive: true });
      writeJson(join(paths.outbox, `${id}.json`), {
        id,
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
    if (req.method !== "POST") {
      reply(405, { error: "只接受 POST" });
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      handle(req, body).then((r) => reply(r.status, r.body)).catch(guard);
    });
    req.on("error", guard);
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
