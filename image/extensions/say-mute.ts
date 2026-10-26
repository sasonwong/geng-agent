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
// How many places this instance may speak into, counted by the daemon. Guessing the
// target is what put a group reply into a private chat, so at two or more it is refused.
const PLACES = Number(process.env.GENG_PLACES ?? "0");
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
    "说话。一次调用里的几句会一起送到；分几次调用就是隔一阵说一句。没人问你的时候也可以说。",
  parameters: Type.Object({
    messages: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 20,
      description: "要说的话，一句一个元素。",
    }),
    to: Type.Optional(
      Type.String({
        description: "发给哪个 chat 的 id（见提示词里的「能说话的地方」）。",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 10,
        description: "一起发出去的文件，写 /work 里的绝对路径（例如 /work/report.html）。",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const messages = params.messages.filter((m) => m.trim() !== "");
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "没说什么。" }], details: undefined };
    }
    if (params.to === undefined && PLACES >= 2) {
      throw new Error("有两处以上能说话，to 必填：提示词「能说话的地方」里有各个 chat 的 id。");
    }
    const chat = params.to === undefined ? undefined : Number(params.to);
    if (params.to !== undefined && !Number.isFinite(chat)) {
      return { content: [{ type: "text", text: `to 要写 chat 的 id：${params.to} 不是。` }], details: undefined };
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
    "在一个会话里，平时的消息不会叫醒你——只在你下一轮醒来时摆在那儿。用这个说\"接下来这段时间，那儿的消息直接叫我\"。到点自动失效。",
  parameters: Type.Object({
    chats: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 10,
      description: "要听哪些会话的 chat id（见提示词「能说话的地方」）。写 * 是所有会话。空数组表示不再听了。",
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
      description: '要安静的来源："*"（全部环境噪音）、"dm"（私聊）、或 "chat:<id>"。',
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
