/**
 * say / mute / listen / forget / propose — the things the agent can do to the world
 * outside its own writing.
 *
 * `say` writes /outbox, which the gateway drains; everything else changes a file in
 * /state that the gateway or the daemon reads, and /state is a mount this container may
 * not write. Those go through the book endpoint instead: the host builds the file from
 * these words, so the shape of the book stays a fact of the host.
 *
 * None of it talks to Telegram. The container has no bot token, and must not have one.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postJson } from "./lib/uds.ts";

const STATE = process.env.GENG_STATE ?? "/state";
const SOCKET = process.env.GENG_BOOK_SOCK ?? "";
// mounted at the top level on purpose: a mount nested under /state makes docker create
// its mountpoint inside the bind, which lands in the agent's own book as a root-owned dir
const OUTBOX = process.env.GENG_OUTBOX ?? "/outbox";
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

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** The endpoint's answer as a sentence, or the host's own refusal. */
async function send(route: string, body: Record<string, unknown>): Promise<{ ok: boolean; reply: Record<string, unknown> }> {
  if (SOCKET === "") return { ok: false, reply: { error: "没有配置记忆端点：GENG_BOOK_SOCK 是空的。" } };
  try {
    const r = await postJson(SOCKET, route, body);
    const reply = JSON.parse(r.body) as Record<string, unknown>;
    return { ok: typeof reply.error !== "string", reply };
  } catch (err) {
    return { ok: false, reply: { error: (err as Error).message } };
  }
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
      // the handler below already turns an empty list into "不听了" and clears
      // attention.json; minItems: 1 was the only thing standing between the two.
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
    const chats: (number | "*")[] = [];
    for (const c of raw) {
      if (c === "*") {
        chats.push("*");
        continue;
      }
      const n = Number(c);
      if (!Number.isFinite(n)) {
        return { content: [{ type: "text", text: `要写 chat 的 id 或 *：${raw.join("、")} 里有的不是。` }], details: undefined };
      }
      chats.push(n);
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
    const { ok, reply } = await send("/attention/set", { chats, until: params.until, why: params.why });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    if (chats.length === 0) return { content: [{ type: "text", text: "不听了。" }], details: undefined };
    return {
      content: [{ type: "text", text: `听着了：${chats.join("、")}，到 ${String(reply.until)} 为止（那时之后又按原样）。` }],
      details: reply,
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
    const { ok, reply } = await send("/files/forget", { files });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    return {
      content: [{ type: "text", text: `下一轮醒来前删掉 ${files.length} 个。` }],
      details: reply,
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
        '要安静的来源："*"（全部环境噪音）或 "chat:<id>"——id 就是「能说话的地方」里那些数字。只有群里的闲话能压；私聊、@、回复永远叫醒你，所以 "dm" 不是合法 target。',
    }),
    minutes: Type.Integer({ minimum: 1, maximum: 10080, description: "安静多少分钟。" }),
    why: Type.String({ description: "为什么。会写进你下次醒来的纸上。" }),
  }),
  async execute(_toolCallId, params) {
    const target = params.target.trim();
    // The gateway settles dm / mention / reply *before* it looks at mute.json, so those
    // keys are silence in name only. Refusing beats writing a line that will never do
    // anything and reporting "安静到 …". The host refuses this too (keyCanMute); saying
    // it here as well costs a sentence and saves a round trip.
    if (target === "dm") {
      return {
        content: [
          {
            type: "text",
            text: 'dm 静音不起作用，没写：私聊在查静音之前就被判成「叫醒它」。要压群里的闲话用 "chat:<群 id>"，全部环境噪音用 "*"。',
          },
        ],
        details: undefined,
      };
    }
    const { ok, reply } = await send("/mute/set", { target, minutes: params.minutes, why: params.why });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    return {
      content: [{ type: "text", text: `安静到 ${String(reply.until)}。` }],
      details: reply,
    };
  },
});

const proposeTool = defineTool({
  name: "propose",
  label: "Propose",
  description:
    "申请改自己的运行条件，下次醒来前生效。只认时机和阈值：" +
    '{"cycle":{"defaultWakeMinutes":30}}。runner、容器限额、网络、timeout 不在这张桌子上。',
  parameters: Type.Object({
    value: Type.String({
      description: '要改的东西，JSON 对象，形如 {"cycle":{"defaultWakeMinutes":30}}。',
    }),
  }),
  async execute(_toolCallId, params) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.value);
    } catch {
      return { content: [{ type: "text", text: `不是 JSON：${params.value}` }], details: undefined };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        content: [{ type: "text", text: '要是一个对象，形如 {"cycle":{"defaultWakeMinutes":30}}。' }],
        details: undefined,
      };
    }
    const { ok, reply } = await send("/proposal", { value: parsed });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    const will = Array.isArray(reply.willApply) ? (reply.willApply as string[]) : [];
    const ignored = Array.isArray(reply.ignored) ? (reply.ignored as string[]) : [];
    const lines = [will.length === 0 ? "记下了，但里面没有一处是能改的。" : `下次醒来前生效：${will.join("、")}。`];
    if (ignored.length > 0) lines.push(`这些不在可谈的范围里，不会生效：${ignored.join("、")}。`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: reply };
  },
});

export default function (pi: ExtensionAPI) {
  if (!existsSync(STATE)) return;
  pi.registerTool(sayTool);
  pi.registerTool(listenTool);
  pi.registerTool(forgetTool);
  pi.registerTool(muteTool);
  pi.registerTool(proposeTool);
}
