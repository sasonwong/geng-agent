/**
 * recall / open — the reading half of the book.
 *
 * Writes are one verb per object (`journal`, `loop_open`, `loop_close`, `wait`); reads
 * are generalised, because asking one question of five places is the same question.
 * Nothing here writes, except the one thing reading is allowed to mean: a mail that has
 * been opened is a mail that is no longer new, so `open` tells the host — it is the host
 * that keeps the list, because /state is a mount it may not write.
 *
 * Everything is a plain read of a read-only mount. The point of a tool rather than
 * `cat`/`grep` is that the round's ledger can name it: `bash` three times says a round
 * was busy, `recall` then `open` says a round went looking.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postJson } from "./lib/uds.ts";

const STATE = process.env.GENG_STATE ?? "/state";
const MAIL = process.env.GENG_MAIL ?? "/mail";
const SESSIONS = process.env.GENG_SESSIONS ?? "/home/agent/.pi/agent/sessions";
const SOCKET = process.env.GENG_BOOK_SOCK ?? "";

// one page of body per `open`: a long session is its own decision, not a default
const PAGE = 8_000;
const LINE = 160;

type Source = "journal" | "loops" | "mail" | "sessions";
const SOURCES: Source[] = ["journal", "loops", "mail", "sessions"];

interface Item {
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

function journalItems(): Item[] {
  return files(join(STATE, "journal"), ".md").map((f) => {
    const body = read(f);
    return { id: basename(f, ".md"), source: "journal" as const, at: when(f), header: firstLine(body), body };
  });
}

/** Open and closed alike: a closed one is still the answer to "how did that end". */
function loopItems(): Item[] {
  const dirs = [join(STATE, "open-loops"), join(STATE, "open-loops", "closed")];
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

interface MailFile {
  id?: unknown;
  at?: unknown;
  from?: unknown;
  subject?: unknown;
  text?: unknown;
}

function mailItems(): Item[] {
  return files(MAIL, ".json").flatMap((f) => {
    let raw: MailFile;
    try {
      raw = JSON.parse(read(f)) as MailFile;
    } catch {
      return [];
    }
    if (typeof raw.id !== "string") return [];
    const body = typeof raw.text === "string" ? raw.text : "";
    const from = typeof raw.from === "string" ? raw.from : "（没有发件人）";
    const subject = typeof raw.subject === "string" ? raw.subject : "（无主题）";
    return [
      {
        id: raw.id,
        source: "mail" as const,
        at: typeof raw.at === "string" ? raw.at : when(f),
        header: `${from} · ${subject}`,
        body,
      },
    ];
  });
}

/** One line of transcript per record: what was said, and which tool ran. */
function render(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const m = r.message as { role?: string; content?: unknown } | undefined;
    const role = m?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: string[] = [];
    const content = m?.content;
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

/**
 * The id is the file's own timestamp to the second, so it sorts, it reads as a date, and
 * two rounds that start in the same minute cannot collide.
 */
function sessionItems(): Item[] {
  let projects: string[];
  try {
    projects = readdirSync(SESSIONS).filter((d) => d.startsWith("--"));
  } catch {
    return [];
  }
  return projects.flatMap((project) =>
    files(join(SESSIONS, project), ".jsonl").map((f) => {
      const name = basename(f, ".jsonl");
      const body = render(read(f).split("\n"));
      return {
        id: `S${name.slice(0, 19)}`,
        source: "sessions" as const,
        at: when(f),
        header: `${body.split("\n").length} 段`,
        body,
      };
    }),
  );
}

function collect(source: Source): Item[] {
  if (source === "journal") return journalItems();
  if (source === "loops") return loopItems();
  if (source === "mail") return mailItems();
  return sessionItems();
}

function all(sources: Source[]): Item[] {
  return sources
    .flatMap(collect)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** The first line that mentions it, with the id it belongs to. */
function hits(item: Item, query: string): string[] {
  const needle = query.toLowerCase();
  const lines = item.body.split("\n");
  const found: string[] = [];
  for (const line of lines) {
    if (line.toLowerCase().includes(needle)) {
      found.push(line.trim().slice(0, LINE));
      if (found.length >= 3) break;
    }
  }
  return found;
}

function describe(item: Item): string {
  return `${item.id}  ${item.source}  ${item.at.slice(0, 16).replace("T", " ")}  ${item.header}`;
}

/**
 * `open` guesses the source from the id's shape and reads that one first — a session or a
 * journal is cheap to look in, and `recall` prints the ids it will accept. A mail id is
 * opaque, so it is tried last for `J`/`L`/`S` and first for everything else.
 */
function find(id: string): Item | null {
  const first: Source = id.startsWith("J")
    ? "journal"
    : id.startsWith("L")
      ? "loops"
      : id.startsWith("S")
        ? "sessions"
        : "mail";
  const order: Source[] = [first, ...SOURCES.filter((s) => s !== first)];
  for (const source of order) {
    const hit = collect(source).find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

async function markRead(ids: string[]): Promise<string> {
  if (SOCKET === "" || ids.length === 0) return "";
  try {
    const r = await postJson(SOCKET, "/mail/read", { ids });
    const body = JSON.parse(r.body) as { error?: string; left?: number };
    if (typeof body.error === "string") return `（标不上已读：${body.error}）`;
    return typeof body.left === "number" ? `（还剩 ${body.left} 封没打开）` : "";
  } catch (err) {
    return `（标不上已读：${(err as Error).message}）`;
  }
}

const recallTool = defineTool({
  name: "recall",
  label: "Recall",
  description:
    "翻自己的书：日记、没闭合和已闭合的事、收到的邮件、醒过的每一轮。不给 query 就按时间列出最近的；" +
    "给了 query 就只回出现它的那几行。要看全文用 open(id)。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "要找的词。不给就是最近的东西。" })),
    sources: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("journal"),
          Type.Literal("loops"),
          Type.Literal("mail"),
          Type.Literal("sessions"),
        ]),
        { description: "只翻这几处，默认全翻。" },
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "最多几条，默认 20。" })),
  }),
  async execute(_toolCallId, params) {
    const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
    const sources = (params.sources ?? SOURCES).filter((s): s is Source => SOURCES.includes(s));
    const limit = params.limit ?? 20;
    const query = (params.query ?? "").trim();
    const items = all(sources);
    if (items.length === 0) return say("这几处都还是空的。");

    if (query === "") {
      const shown = items.slice(0, limit);
      const lines = shown.map(describe);
      if (items.length > shown.length) lines.push(`（还有 ${items.length - shown.length} 条更早的）`);
      return say(lines.join("\n"));
    }

    const out: string[] = [];
    for (const item of items) {
      const found = hits(item, query);
      if (found.length === 0) continue;
      out.push(`${item.id}  ${item.source}  ${item.at.slice(0, 16).replace("T", " ")}`);
      for (const line of found) out.push(`  ${line}`);
      if (out.length >= limit) break;
    }
    return say(out.length === 0 ? `没有哪一处提到「${query}」。` : out.join("\n"));
  },
});

const openTool = defineTool({
  name: "open",
  label: "Open",
  description:
    "读一件东西的全文：日记、没闭合的事、一封邮件、醒过的一轮。id 来自 recall 或者写的时候拿到的。" +
    "长的一页读不完，会用 offset 告诉你怎么接着读。打开邮件就算处理过了。",
  parameters: Type.Object({
    id: Type.String({ description: "要读的那一件，形如 J20260303-2、L12、S2026-11-04T03:34:30。" }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几个字开始，接着上次读。" })),
  }),
  async execute(_toolCallId, params) {
    const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
    const id = params.id.trim();
    const item = find(id);
    if (!item) return say(`没有这一件：${id}。用 recall 看有哪些。`);
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const page = item.body.slice(offset, offset + PAGE);
    const rest = item.body.length - offset - page.length;
    const out = [`${item.id}  ${item.source}  ${item.at.slice(0, 16).replace("T", " ")}`, ""];
    out.push(page === "" ? "（这一件没有正文）" : page);
    if (rest > 0) out.push("", `（还有 ${rest} 字，offset=${offset + page.length} 接着读）`);
    if (item.source === "mail") {
      const note = await markRead([item.id]);
      if (note !== "") out.push("", note);
    }
    return say(out.join("\n"));
  },
});

export default function (pi: ExtensionAPI): void {
  // an instance may have no mailbox at all; then `recall` still has three other places
  if (existsSync(MAIL) || existsSync(STATE)) {
    pi.registerTool(recallTool);
    pi.registerTool(openTool);
  }
}
