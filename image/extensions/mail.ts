/**
 * mail — the mailbox: read it, mark it.
 *
 * /mail is a read-only mount, so "read" cannot be a file that moves into a read/
 * directory: it is a list of ids in the agent's own book. The tool never talks to the
 * network and cannot send — there is no such thing as an answer to a mail yet.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAIL = process.env.GENG_MAIL ?? "/mail";
const FILES = process.env.GENG_FILES ?? "/files";
const STATE = process.env.GENG_STATE ?? "/state";
// its own book: it may rewrite or delete this file, and then everything counts as unread
const READ_LIST = join(STATE, "mail.read.json");
// one page of body per `read`: a 300 KB newsletter is its own decision, not a default
const PAGE = 8_000;
const LISTED = 20;

interface MailFile {
  id: string;
  text?: string;
  from?: string;
  at?: string;
  subject?: string;
  attachments?: { kind: string; path?: string; note?: string }[];
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function parse(name: string): MailFile | null {
  try {
    const raw = JSON.parse(readFileSync(join(MAIL, name), "utf8")) as Partial<MailFile>;
    if (!raw || typeof raw.id !== "string") return null;
    return {
      id: raw.id,
      text: typeof raw.text === "string" ? raw.text : "",
      from: typeof raw.from === "string" ? raw.from : undefined,
      at: typeof raw.at === "string" ? raw.at : undefined,
      subject: typeof raw.subject === "string" ? raw.subject : undefined,
      attachments: Array.isArray(raw.attachments) ? raw.attachments : undefined,
    };
  } catch {
    return null;
  }
}

/** Newest first. A file nothing can read is skipped, not fatal. */
function all(): MailFile[] {
  let names: string[];
  try {
    names = readdirSync(MAIL).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: MailFile[] = [];
  for (const name of names) {
    const m = parse(name);
    if (m) out.push(m);
  }
  return out.sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}

function readIds(): string[] {
  if (!existsSync(READ_LIST)) return [];
  try {
    const raw = JSON.parse(readFileSync(READ_LIST, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function header(m: MailFile): string {
  return `${m.id}  ${m.at ?? "（没有时间）"}  ${m.from ?? "（没有发件人）"}  ${m.subject ?? "（无主题）"}`;
}

const mailTool = defineTool({
  name: "mail",
  label: "Mail",
  description:
    "信箱。邮件不会叫醒你，醒着的时候才看得见。list 看没处理的，read 读一封，mark 标已读——不标就一直算没处理。发不出去：这里没有回信的通道。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("mark")], {
      description: "list 列出；read 读一封；mark 标已读。",
    }),
    scope: Type.Optional(
      Type.Union([Type.Literal("unread"), Type.Literal("all")], {
        description: "list 用：unread（默认）只列没处理的，all 连已读的一起列。",
      }),
    ),
    id: Type.Optional(Type.String({ description: "read 用：list 出来的那个 id。" })),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "read 用：正文从第几个字开始，接着上次读。" }),
    ),
    ids: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 50,
        description: "mark 用：要标已读的 id，可以一次给多个。",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
    // an instance without mail has no /mail at all: that is not an empty mailbox, and
    // "nothing unread" would be a small lie about the world
    if (!existsSync(MAIL)) return say("这个实例没有信箱。");
    const known = all();
    const read = new Set(readIds());
    const unread = (m: MailFile): boolean => !read.has(m.id);

    if (params.action === "list") {
      const scope = params.scope ?? "unread";
      const shown = scope === "all" ? known : known.filter(unread);
      if (shown.length === 0) return say(scope === "all" ? "信箱是空的。" : "没有没处理的邮件。");
      const lines = shown.slice(0, LISTED).map(header);
      if (shown.length > LISTED) lines.push(`（上面是新的 ${LISTED} 封，一共 ${shown.length} 封）`);
      if (scope !== "all" && known.length > shown.length) {
        lines.push(`（另外 ${known.length - shown.length} 封已经标过已读）`);
      }
      return say(lines.join("\n"));
    }

    if (params.action === "read") {
      const id = params.id ?? "";
      const one = known.find((m) => m.id === id);
      if (!one) return say(`没有这封：${id === "" ? "（没给 id）" : id}。先用 list 看有哪些。`);
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      const text = one.text ?? "";
      const page = text.slice(offset, offset + PAGE);
      const rest = text.length - offset - page.length;
      const out = [`发件人 ${one.from ?? "（没有）"} · ${one.at ?? "（没有时间）"} · ${one.id}`];
      // /files has its own cap and its own forget, so a path in a mail can be a file the
      // daemon has already pruned: say so here rather than printing a lie
      const came = (one.attachments ?? []).map((a) => {
        if (!a.path) return a.note ?? "（没取到）";
        return existsSync(join(FILES, a.path.replace(/^\/files\//, "")))
          ? a.path
          : `${a.path}（已经删掉了）`;
      });
      if (came.length > 0) out.push(`一起发来的：${came.join("、")}`);
      out.push("", page === "" ? "（这一封没有正文）" : page);
      if (rest > 0) out.push("", `（还有 ${rest} 字，offset=${offset + page.length} 接着读）`);
      if (unread(one)) out.push("", "还没标已读。");
      return say(out.join("\n"));
    }

    const wanted = (params.ids ?? []).filter((x) => typeof x === "string" && x.trim() !== "");
    if (wanted.length === 0) return say("没说要标哪几封。");
    const exists = new Set(known.map((m) => m.id));
    const real = wanted.filter((id) => exists.has(id));
    const missing = wanted.filter((id) => !exists.has(id));
    const merged = [...new Set([...read, ...real])];
    try {
      writeAtomic(READ_LIST, JSON.stringify(merged, null, 2) + "\n");
    } catch (err) {
      return say(`标不上：${(err as Error).message}`);
    }
    const left = known.filter((m) => !new Set(merged).has(m.id)).length;
    const marked = real.filter((id) => !read.has(id)).length;
    const out = [`标了 ${marked} 封已读，还剩 ${left} 封没处理。`];
    if (missing.length > 0) out.push(`没有这些：${missing.join("、")}（没动）。`);
    return say(out.join("\n"));
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(mailTool);
}
