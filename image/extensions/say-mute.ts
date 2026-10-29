/**
 * say / mute — the two things the agent can do to a person instead of to a file.
 *
 * Both write into /state, which the gateway reads. They never talk to Telegram
 * themselves: the container has no bot token, and must not have one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE = process.env.GENG_STATE ?? "/state";
// mounted at the top level on purpose: a mount nested under /state makes docker create
// its mountpoint inside the bind, which lands in the agent's own book as a root-owned dir
const OUTBOX = process.env.GENG_OUTBOX ?? "/outbox";
const MUTE = join(STATE, "mute.json");
const ATTENTION = join(STATE, "attention.json");
// four hours is the most it may ask for: longer than that is not attention, it is a rule
const ATTENTION_MAX_MS = 4 * 3_600_000;
// Where this instance may speak, as chat ids. A count was not enough: a waking that
// wanted to quote a message had no number to put in `replyTo`, invented one, and the
// gateway dropped the message while this tool still reported "说了 N 句".
//
// The count is still sent and still read, because the image and the daemon are upgraded
// separately: a daemon older than this file sends only the count (no list, so nothing to
// check against), and an extension older than this daemon reads only the count and keeps
// working. Reading the ids alone would make the first case refuse every chat with
// "能发的是 1" — a speaking channel that goes quiet while the tool says it refused.
// shortcut: no id check while only the count arrives; drop GENG_PLACES once the image and
// the daemon are known to ship together.
const PLACE_IDS = (process.env.GENG_PLACE_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "") // an instance with no places sends the empty string, and
  .map(Number) // Number("") is 0 — a chat id nobody could ever send from
  .filter((n) => Number.isFinite(n));
/** null: a daemon that only knows how many there are, so there is no list to check. */
const PLACES: number[] | null = PLACE_IDS.length > 0 ? PLACE_IDS : null;
const COUNT = Number(process.env.GENG_PLACES ?? "0");
const placeCount = PLACES?.length ?? (Number.isFinite(COUNT) ? COUNT : 0);
const FORGET = join(STATE, "files.forget.json");

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const sayTool = defineTool({
  name: "say",
  label: "Say",
  description:
    "对一个人说话。一次调用里的几句一起送到；分几次调用就是隔一阵说一句。没人问你的时候也可以说。只有一个地方能说话时不用写 to，两处以上必须写。replyTo 写「chat id-消息 id」，形如 -1001234567890-151（id 在 /inbox 的文件名里，也在 /people/<chat>.jsonl 每行的 id 里）。",
  parameters: Type.Object({
    messages: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 20,
      description: "要说的话，一句一个元素。",
    }),
    to: Type.Optional(
      Type.String({
        description: "发到哪个 chat：「能说话的地方」里那些数字 id（不是 @handle）。",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 10,
        description: "一起发出去的文件，写 /work 里的绝对路径（例如 /work/report.html）。",
      }),
    ),
    replyTo: Type.Optional(
      Type.String({
        description:
          "引用哪一条：chat id-消息 id，形如 -1001234567890-151。写了它就发到那条消息所在的会话，to 可以省。",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const messages = params.messages.filter((m) => m.trim() !== "");
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "没说什么。" }], details: undefined };
    }
    // shape only: the gateway re-parses this, and it is what drops a quote that does not
    // belong to the chat being spoken into
    let quote: { chat: number; messageId: number } | null = null;
    if (params.replyTo !== undefined) {
      const cut = params.replyTo.lastIndexOf("-");
      const c = Number(params.replyTo.slice(0, cut));
      const m = Number(params.replyTo.slice(cut + 1));
      if (cut <= 0 || !Number.isSafeInteger(c) || !Number.isSafeInteger(m) || m <= 0) {
        return {
          content: [{ type: "text", text: `replyTo 要写收件箱里的那个 id：${params.replyTo} 不是。` }],
          details: undefined,
        };
      }
      quote = { chat: c, messageId: m };
    }
    // quoting one message already says which conversation it belongs to
    const target = params.to !== undefined ? Number(params.to) : (quote?.chat ?? undefined);
    if (target === undefined && placeCount >= 2) {
      throw new Error("有两处以上能说话，to 必填：提示词「能说话的地方」里有各个 chat 的 id。");
    }
    const chat = target;
    if (params.to !== undefined && !Number.isFinite(chat)) {
      return { content: [{ type: "text", text: `to 要写 chat 的 id：${params.to} 不是。` }], details: undefined };
    }
    if (placeCount === 0) {
      return {
        content: [
          { type: "text", text: "现在没有能说话的地方：还没有人跟你的 bot 说过话，发出去也没人收到。" },
        ],
        details: undefined,
      };
    }
    // A chat that is not on the list is a message nobody will ever read: the gateway drops
    // it and acks it, so "说了 N 句" here would be this tool lying to the one asking.
    if (chat !== undefined && PLACES !== null && !PLACES.includes(chat)) {
      return {
        content: [
          {
            type: "text",
            text: `这个 chat 不在你能说话的地方里：${chat} 不是。能发的是 ${PLACES.join("、")}。`,
          },
        ],
        details: undefined,
      };
    }
    const files = (params.files ?? []).filter((f) => f.trim() !== "");
    const id = nextId();
    writeAtomic(
      join(OUTBOX, `${id}.json`),
      JSON.stringify({
        id,
        messages,
        ...(chat === undefined ? {} : { chat }),
        ...(files.length === 0 ? {} : { files }),
        ...(quote === null ? {} : { replyTo: quote }),
      }) + "\n",
    );
    return {
      content: [
        {
          type: "text",
          text: `说了 ${messages.length} 句${files.length === 0 ? "" : `，带 ${files.length} 个文件`}。`,
        },
      ],
      details: { id, count: messages.length },
    };
  },
});

const listenTool = defineTool({
  name: "listen",
  label: "Listen",
  description:
    "让某个会话的消息直接叫醒你：平时那些消息只在你下一轮醒来时摆在那儿。到点自动失效，最长四小时。",
  parameters: Type.Object({
    chats: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 10,
      description:
        "要听哪些会话的 chat id（纯数字，不是 @handle，也不是 telegram:xxx）。写 * 是所有会话。空数组表示不再听了。",
    }),
    until: Type.Optional(
      Type.String({
        description: "听到什么时候，ISO 时间（例如 2026-10-26T17:00:00Z）。不写就是四小时后。最长四小时。",
      }),
    ),
    why: Type.Optional(Type.String({ description: "为什么听——给自己看的一句话。" })),
  }),
  async execute(_toolCallId, params) {
    const raw = params.chats.map((c) => c.trim()).filter((c) => c !== "");
    if (raw.length === 0) {
      writeAtomic(ATTENTION, "{}\n");
      return { content: [{ type: "text", text: "不听了。" }], details: undefined };
    }
    const chats = raw.map((c) => (c === "*" ? "*" : Number(c)));
    if (chats.some((c) => c !== "*" && !Number.isFinite(c))) {
      return {
        content: [{ type: "text", text: `要写 chat 的 id 或 *：${raw.join("、")} 里有的不是。` }],
        details: undefined,
      };
    }
    // a window on a chat that never sends is a window that silently never opens
    if (PLACES !== null) {
      const unknown = chats.filter((c) => c !== "*" && !PLACES.includes(c));
      if (unknown.length > 0) {
        return {
          content: [
            { type: "text", text: `这些 chat 不在你能说话的地方里：${unknown.join("、")}。能听的是 ${PLACES.join("、")} 或 *。` },
          ],
          details: undefined,
        };
      }
    }
    const now = Date.now();
    const wanted = params.until ? Date.parse(params.until) : NaN;
    const until = Math.min(Number.isNaN(wanted) ? now + ATTENTION_MAX_MS : wanted, now + ATTENTION_MAX_MS);
    if (until <= now) {
      return { content: [{ type: "text", text: `那个时间已经过去了：${params.until}` }], details: undefined };
    }
    writeAtomic(
      ATTENTION,
      JSON.stringify({ chats, until: new Date(until).toISOString(), why: params.why ?? "", at: new Date(now).toISOString() }, null, 2) + "\n",
    );
    return {
      content: [
        {
          type: "text",
          text: `听着了：${chats.join("、")}，到 ${new Date(until).toISOString()} 为止（那时之后又按原样）。`,
        },
      ],
      details: { chats, until: new Date(until).toISOString() },
    };
  },
});

const forgetTool = defineTool({
  name: "forget",
  label: "Forget files",
  description:
    "删掉 /files 里的文件，为了腾地方。下一轮醒来之前生效——这一轮你还能读到它们。",
  parameters: Type.Object({
    files: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 50,
      description: "要删的文件，写 /files 里的路径，例如 /files/123456789-1-photo.jpg。",
    }),
  }),
  async execute(_toolCallId, params) {
    const files = params.files.map((f) => f.trim()).filter((f) => f !== "");
    if (files.length === 0) {
      return { content: [{ type: "text", text: "没说要删什么。" }], details: undefined };
    }
    let current: { files?: string[] } = {};
    try {
      current = JSON.parse(readFileSync(FORGET, "utf8")) as { files?: string[] };
    } catch {
      current = {};
    }
    const all = [...new Set([...(current.files ?? []), ...files])];
    writeAtomic(FORGET, JSON.stringify({ files: all, at: new Date().toISOString() }, null, 2) + "\n");
    return {
      content: [{ type: "text", text: `下一轮醒来前删掉 ${files.length} 个。` }],
      details: { files },
    };
  },
});

const muteTool = defineTool({
  name: "mute",
  label: "Mute",
  description:
    "安静一段时间：把某个来源从「会叫醒你」降成「等你下次醒来再看」。消息一条都不会丢。直接对你说话的人（@你、回复你、私聊你）不受影响。",
  parameters: Type.Object({
    target: Type.String({
      description:
        '要安静的来源："*"（全部环境噪音）、"dm"（私聊）、或 "chat:<id>"——id 就是「能说话的地方」里那些数字。',
    }),
    minutes: Type.Integer({ minimum: 1, maximum: 10080, description: "安静多少分钟。" }),
    why: Type.String({ description: "为什么。会写进你下次醒来的纸上。" }),
  }),
  async execute(_toolCallId, params) {
    const until = new Date(Date.now() + params.minutes * 60_000).toISOString();
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(MUTE, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current[params.target] = { until, why: params.why };
    writeAtomic(MUTE, JSON.stringify(current, null, 2) + "\n");
    return {
      content: [{ type: "text", text: `安静到 ${until}。` }],
      details: { target: params.target, until },
    };
  },
});

export default function (pi: ExtensionAPI) {
  if (!existsSync(STATE)) return;
  pi.registerTool(sayTool);
  pi.registerTool(listenTool);
  pi.registerTool(forgetTool);
  pi.registerTool(muteTool);
}
