import { readdirSync, readFileSync, statSync } from "node:fs";
import { listFiles } from "./ids.ts";
import { basename, join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./fs.ts";

/**
 * The reading half of the book, on the host.
 *
 * It lives here rather than in the extension because the container no longer has the
 * book at all: `/state`, `/mail`, `/people` and `/inbox` are not mounted, so every read
 * is a call and every call is a line in the ledger. A `cat` can no longer count as a
 * read of something the daemon cannot name.
 */
export type Source = "journal" | "loops" | "mail" | "people" | "inbox" | "sessions" | "files";
export const SOURCES: Source[] = ["journal", "loops", "mail", "people", "inbox", "sessions", "files"];

const PAGE = 8_000;
const LINE = 160;

export interface Item {
  id: string;
  source: Source;
  at: string;
  /** One line standing in for the whole thing, for a listing. */
  header: string;
  body: string;
}

function files(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(ext))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function when(file: string): string {
  try {
    return new Date(statSync(file).mtimeMs).toISOString();
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, LINE);
}

/** A discarded entry stays here: the book records that it happened, not only what is left. */
function journalItems(p: Paths): Item[] {
  const dirs = [p.journal, p.journalDiscarded];
  return dirs.flatMap((dir) =>
    files(dir, ".md")
      // only ids: a stray note in the directory is not an entry
      .filter((f) => /^J\d+-\d+\.md$/.test(basename(f)))
      .map((f) => {
        const body = read(f);
        return {
          id: basename(f, ".md"),
          source: "journal" as const,
          at: when(f),
          header: `${dir === p.journalDiscarded ? "已丢弃 " : ""}${firstLine(body)}`,
          body,
        };
      }),
  );
}

/** Open and closed alike: a closed one is still the answer to "how did that end". */
function loopItems(p: Paths): Item[] {
  const dirs = [p.openLoops, join(p.openLoops, "closed")];
  return dirs.flatMap((dir) =>
    files(dir, ".md").map((f) => {
      const body = read(f);
      return {
        id: basename(f, ".md"),
        source: "loops" as const,
        at: when(f),
        header: `${dir.endsWith("closed") ? "已闭合" : "未闭合"} ${firstLine(body)}`,
        body,
      };
    }),
  );
}

function mailItems(p: Paths): Item[] {
  return files(p.mail, ".json").flatMap((f) => {
    const raw = readJson<{
    id?: unknown;
    at?: unknown;
    from?: unknown;
    subject?: unknown;
    text?: unknown;
    attachments?: unknown;
  } | null>(f, null);
    if (!raw || typeof raw.id !== "string") return [];
    const from = typeof raw.from === "string" ? raw.from : "（没有发件人）";
    const subject = typeof raw.subject === "string" ? raw.subject : "（无主题）";
    return [
      {
        id: raw.id,
        source: "mail" as const,
        at: typeof raw.at === "string" ? raw.at : when(f),
        header: `${from} · ${subject}`,
        body: [
          typeof raw.text === "string" ? raw.text : "",
          ...(Array.isArray(raw.attachments)
            ? (raw.attachments as { id?: unknown; name?: unknown; note?: unknown }[]).map((a) =>
                typeof a.id === "string" ? `附件 ${a.id}：${typeof a.name === "string" ? a.name : "文件"}` : `附件：${String(a.note ?? "没取")}`,
              )
            : []),
        ]
          .filter((l) => l !== "")
          .join("\n"),
      },
    ];
  });
}

interface SaidLine {
  at?: unknown;
  dir?: unknown;
  text?: unknown;
  from?: unknown;
  id?: unknown;
}

/** One item per person, with the whole transcript as its body: `open` pages it. */
function peopleItems(p: Paths): Item[] {
  return files(p.people, ".jsonl").flatMap((f) => {
    const chat = basename(f, ".jsonl");
    if (!/^-?\d+$/.test(chat)) return [];
    const lines: string[] = [];
    for (const line of read(f).split("\n")) {
      if (line.trim() === "") continue;
      let said: SaidLine;
      try {
        said = JSON.parse(line) as SaidLine;
      } catch {
        continue;
      }
      if (typeof said.text !== "string" || said.text === "") continue;
      const who = said.dir === "out" ? "→" : `← ${typeof said.from === "string" ? said.from : "对方"}`;
      // the id is what `say` quotes with: a transcript without it can only answer the
      // newest line, and the model would have to invent the number it puts in `replyTo`
      const ref = typeof said.id === "string" && said.id !== "" ? ` #${said.id}` : "";
      lines.push(`${typeof said.at === "string" ? said.at.slice(11, 16) : "??:??"} ${who}${ref} ${said.text}`);
    }
    const last = lines[lines.length - 1] ?? "（没说过话）";
    return [
      {
        id: `P${chat}`,
        source: "people" as const,
        at: when(f),
        header: last.slice(0, LINE),
        body: lines.join("\n"),
      },
    ];
  });
}

interface InboxFile {
  id?: unknown;
  at?: unknown;
  from?: unknown;
  text?: unknown;
}

/**
 * Both inboxes: what knocked and what waited. The id is the file name, because that is
 * what `open` has to find again, and it carries the chat and message ids `say` quotes.
 */
function inboxItems(p: Paths): Item[] {
  const dirs = [p.inbox, p.inboxLow];
  return dirs.flatMap((dir) =>
    files(dir, ".json").map((f) => {
      const raw = readJson<InboxFile | null>(f, null) ?? {};
      const text = typeof raw.text === "string" ? raw.text : "";
      const from = typeof raw.from === "string" ? raw.from : "（不知道谁）";
      return {
        id: `M${basename(f, ".json")}`,
        source: "inbox" as const,
        at: typeof raw.at === "string" ? raw.at : when(f),
        header: `${from} · ${firstLine(text)}`,
        body: `${from} · ${typeof raw.at === "string" ? raw.at : "（没有时间）"} · id=${basename(f, ".json")}\n\n${text}`,
      };
    }),
  );
}

interface SessionLine {
  message?: { role?: string; content?: unknown };
}

/** One line of transcript per record: what was said, and which tool ran. */
function render(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let rec: SessionLine;
    try {
      rec = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    const role = rec.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: string[] = [];
    const content = rec.message?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        else if (b.type === "toolCall" && typeof b.name === "string") parts.push(`[${b.name}]`);
      }
    }
    const text = parts.join(" ").trim();
    if (text !== "") out.push(`${role === "user" ? "←" : "→"} ${text}`);
  }
  return out.join("\n");
}

/** The id is the file's own timestamp to the second: it sorts, and it reads as a date. */
function sessionItems(p: Paths): Item[] {
  let projects: string[];
  try {
    projects = readdirSync(p.sessionDir).filter((d) => d.startsWith("--"));
  } catch {
    return [];
  }
  return projects.flatMap((project) =>
    files(join(p.sessionDir, project), ".jsonl").map((f) => {
      const body = render(read(f).split("\n"));
      return {
        id: (() => {
          const counter = /-(\d+)\.jsonl$/.exec(basename(f));
          // the daemon numbers its wakings; a session made some other way has no number
          // to align with, so it keeps its timestamp but stays under the same letter
          return counter ? `R${Number(counter[1])}` : `R${basename(f, ".jsonl").slice(0, 19)}`;
        })(),
        source: "sessions" as const,
        at: when(f),
        header: `${body.split("\n").length} 段`,
        body,
      };
    }),
  );
}

/** The path a listed file actually has: the index sits between the id and the name. */
function statOf(p: Paths, id: string, name: string): string {
  let mtime = 0;
  for (const entry of readdirSync(p.filesDir)) {
    if (entry.startsWith(`${id}-`) && entry.endsWith(`-${name}`)) {
      mtime = statSync(join(p.filesDir, entry)).mtimeMs;
    }
  }
  return new Date(mtime).toISOString();
}

/** Files carry no text, so what a listing can say is what they are called and how big. */
function fileItems(p: Paths): Item[] {
  return listFiles(p).map((f) => {
    let at = "";
    try {
      at = statOf(p, f.id, f.name);
    } catch {
      at = "";
    }
    return {
      id: f.id,
      source: "files" as const,
      at,
      // a small file in KB rounds to 1 and reads as bigger than it is
      header: `${f.name}（${f.bytes < 1024 ? `${f.bytes} 字节` : `${Math.round(f.bytes / 1024)} KB`}）`,
      body: `${f.name}\n${f.bytes} 字节\n用 download("${f.id}", "/work/...") 取到手上，或者 say(files:["${f.id}"]) 直接发出去。`,
    };
  });
}

function collect(p: Paths, source: Source): Item[] {
  if (source === "journal") return journalItems(p);
  if (source === "loops") return loopItems(p);
  if (source === "mail") return mailItems(p);
  if (source === "people") return peopleItems(p);
  if (source === "inbox") return inboxItems(p);
  if (source === "files") return fileItems(p);
  return sessionItems(p);
}

export function collectAll(p: Paths, sources: Source[]): Item[] {
  return sources
    .flatMap((s) => collect(p, s))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** The first lines that mention it, with the id they belong to. */
function hits(item: Item, query: string): string[] {
  const needle = query.toLowerCase();
  const found: string[] = [];
  for (const line of item.body.split("\n")) {
    if (line.toLowerCase().includes(needle)) {
      found.push(line.trim().slice(0, LINE));
      if (found.length >= 3) break;
    }
  }
  return found;
}

function stamp(at: string): string {
  return at.slice(0, 16).replace("T", " ");
}

export interface RecallQuery {
  query?: unknown;
  sources?: unknown;
  limit?: unknown;
}

/** The listing, as the sentence the agent reads. */
export function recallText(p: Paths, q: RecallQuery): string {
  const asked = Array.isArray(q.sources)
    ? q.sources.filter((s): s is Source => SOURCES.includes(s as Source))
    : SOURCES;
  const sources = asked.length === 0 ? SOURCES : asked;
  const limit = typeof q.limit === "number" && Number.isInteger(q.limit) && q.limit > 0 ? Math.min(q.limit, 50) : 20;
  const query = typeof q.query === "string" ? q.query.trim() : "";
  const items = collectAll(p, sources);
  // a query over nothing has an answer about the word, not about the emptiness
  if (items.length === 0) return query === "" ? "这几处都还是空的。" : `没有哪一处提到「${query}」。`;

  if (query === "") {
    const shown = items.slice(0, limit);
    const lines = shown.map((i) => `${i.id}  ${i.source}  ${stamp(i.at)}  ${i.header}`);
    if (items.length > shown.length) lines.push(`（还有 ${items.length - shown.length} 条更早的）`);
    return lines.join("\n");
  }

  const out: string[] = [];
  for (const item of items) {
    const found = hits(item, query);
    if (found.length === 0) continue;
    out.push(`${item.id}  ${item.source}  ${stamp(item.at)}`);
    for (const line of found) out.push(`  ${line}`);
    if (out.length >= limit) break;
  }
  return out.length === 0 ? `没有哪一处提到「${query}」。` : out.join("\n");
}

/**
 * `open` guesses the source from the id's shape. A mail id is opaque, so it is tried
 * last for the prefixes and first for everything else; `chat:<n>` is a person.
 */
/**
 * One letter decides where an id lives: J journal, L loop, P person, M message,
 * E email, R round, F file. Nothing has to guess by trying four places first, and
 * the letter is visible in every listing so the model can read it off.
 */
const PREFIX: Record<string, Source> = {
  J: "journal",
  L: "loops",
  P: "people",
  M: "inbox",
  E: "mail",
  F: "files",
  R: "sessions",
};

function find(p: Paths, id: string): Item | null {
  const first: Source = PREFIX[id.slice(0, 1)] ?? "mail";
  const order: Source[] = [first, ...SOURCES.filter((s) => s !== first)];
  for (const source of order) {
    const hit = collect(p, source).find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

export interface OpenResult {
  /** Ready to show, or a refusal. */
  text: string;
  found: boolean;
}

/**
 * One thing in full. Opening a mail is what makes it no longer new — the list is written
 * here, in the same call, so there is no second step to forget and no half-open state.
 */
export function openText(p: Paths, id: string, offset: number): OpenResult {
  const item = find(p, id.trim());
  if (!item) return { found: false, text: `没有这一件：${id}。用 recall 看有哪些。` };
  const page = item.body.slice(offset, offset + PAGE);
  const rest = item.body.length - offset - page.length;
  const out = [`${item.id}  ${item.source}  ${stamp(item.at)}`, ""];
  out.push(page === "" ? "（这一件没有正文）" : page);
  if (rest > 0) out.push("", `（还有 ${rest} 字，offset=${offset + page.length} 接着读）`);
  if (item.source === "mail") {
    const had = readJson<unknown>(p.mailRead, []);
    const before = new Set(Array.isArray(had) ? had.filter((x): x is string => typeof x === "string") : []);
    before.add(item.id);
    writeJson(p.mailRead, [...before]);
    out.push("", `（还剩 ${Math.max(0, mailItems(p).length - before.size)} 封没打开）`);
  }
  return { found: true, text: out.join("\n") };
}
