/**
 * say / mute / listen / forget / propose — the things the agent can do to the world
 * outside its own writing.
 *
 * None of them touches the disk: each one is a POST to the book endpoint, which builds the
 * file from these words — the outbox item the gateway drains, the mute map, the attention
 * window, the forget list, the proposal. The host owns every shape, so what the gateway
 * reads is never something the container wrote.
 *
 * None of it talks to Telegram. The container has no bot token, and must not have one.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tool } from "./lib/tool.ts";
import { postJsonOrError } from "./lib/uds.ts";

const SOCKET = process.env.GENG_BOOK_SOCK ?? "";
/** The endpoint's answer as a sentence, or the host's own refusal. */
async function send(route: string, body: Record<string, unknown>): Promise<{ ok: boolean; reply: Record<string, unknown> }> {
  if (SOCKET === "") return { ok: false, reply: { error: "没有配置记忆端点：GENG_BOOK_SOCK 是空的。" } };
  const r = await postJsonOrError(SOCKET, route, body);
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return { ok: false, reply: { error: `记忆端点答了 ${r.status}，但不是 JSON：${r.body.slice(0, 200)}` } };
  }
  return { ok: typeof reply.error !== "string", reply };
}

const sayTool = tool({
  name: "say",
  label: "Say",
  description:
    "对一个人说话。一次调用里的几句一起送到（按顺序），分几次调用就是隔一阵说一句；没人问你的时候也可以说。\n" +
    "to: chat id（纯数字）。只有一个地方能说话时可以省略，两处以上必须写。\n" +
    "files: 一起发出去的文件，两种写法——别人发来的写 id（形如 \"F12\"，不用先 download），自己做的写 /work/… 路径。\n" +
    "replyTo: 引用某一句话，写那条消息的 id（形如 M-1001234567890-151；对话里每句后面也有 #…），" +
    "写了它就发到那条消息所在的会话，to 可以省。\n" +
    "返回 {id, count}：id 是这条排队记录的编号（不是 Telegram 的消息号，那要等发出去之后才有）。发不出去会明说哪一处不对。",
  parameters: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 20,
        description: "要说的话，一句一个元素。",
      },
      to: { type: "string", description: "发到哪个 chat：「能说话的地方」里那些数字 id（不是 @handle）。" },
      files: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "一起发出去的文件：别人发来的写 id（F12），自己做的写 /work 里的绝对路径。",
      },
      replyTo: {
        type: "string",
        description:
          "引用哪一条：那条消息的 id，形如 M-1001234567890-151 或 -1001234567890-151（recall 和对话记录里都印着）。写了它就发到那条消息所在的会话，to 可以省。",
      },
    },
    required: ["messages"],
  },
  async execute(_toolCallId, params) {
    const messages = params.messages.map((m) => m.trim()).filter((m) => m !== "");
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "没说要说什么。" }], details: undefined };
    }
    const files = (params.files ?? []).map((f) => f.trim()).filter((f) => f !== "");
    const { ok, reply } = await send("/say", {
      messages,
      to: params.to,
      files,
      replyTo: params.replyTo,
    });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    return {
      content: [
        {
          type: "text",
          text: `说了 ${String(reply.count)} 句${files.length === 0 ? "" : `，带 ${files.length} 个文件`}，排队号 ${String(reply.id)}。`,
        },
      ],
      details: reply,
    };
  },
});

const listenTool = tool({
  name: "listen",
  label: "Listen",
  description: '让某些会话的消息直接叫醒你——平时它们只摆在收件箱里等你醒。chats 是 chat id 数组，写 "*" 表示全部，空数组表示不听了。until 可选，ISO 时刻，不写就是四小时后，最长四小时。why 可选。返回 {chats, until}。',
  parameters: {
    type: "object",
    properties: {
      chats: {
        type: "array",
        items: { type: "string" },
        // an empty list means "不听了" and clears attention.json, which is why there is
        // no minItems here
        maxItems: 10,
        description:
          "要听哪些会话的 chat id（纯数字，不是 @handle，也不是 telegram:xxx）。写 * 是所有会话。空数组表示不再听了。",
      },
      until: { type: "string", description: "听到什么时候，ISO 时间（例如 2026-10-26T17:00:00Z）。不写就是四小时后。最长四小时。" },
      why: { type: "string", description: "为什么听——给自己看的一句话。" },
    },
    required: ["chats"],
  },
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
    const { ok, reply } = await send("/attention/set", { chats, until: params.until, why: params.why });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    if (chats.length === 0) return { content: [{ type: "text", text: "不听了。" }], details: undefined };
    return {
      content: [{ type: "text", text: `听着了：${chats.join("、")}，到 ${String(reply.until)} 为止（那时之后又按原样）。` }],
      details: reply,
    };
  },
});

const forgetTool = tool({
  name: "forget",
  label: "Forget files",
  description: '删掉别人发来的文件腾地方，下一轮醒来之前生效——这一轮你还听得到它。files 是 id 数组（形如 "F12"；老写法的 /files/… 路径也认），一次最多 50 个。返回 {files}：删掉之后还剩的待删清单。',
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 50,
        description: "要删的文件：写文件 id（F12），或者老写法的 /files/… 路径。",
      },
    },
    required: ["files"],
  },
  async execute(_toolCallId, params) {
    const files = params.files.map((f) => f.trim()).filter((f) => f !== "");
    if (files.length === 0) {
      return { content: [{ type: "text", text: "没说要删什么。" }], details: undefined };
    }
    const { ok, reply } = await send("/files/forget", { files });
    if (!ok) return { content: [{ type: "text", text: String(reply.error) }], details: undefined };
    return {
      content: [{ type: "text", text: `记下了 ${files.length} 个，下一轮醒来前删（已经不在的跳过）。` }],
      details: reply,
    };
  },
});

const muteTool = tool({
  name: "mute",
  label: "Mute",
  description: '安静一段时间：把某个来源从「会叫醒你」降成「下次醒来再看」，消息一条都不丢。target 只能是 "*"（全部环境噪音）或 "chat:<id>"（id 是数字）；dm 不接受——私聊、@你、回复你永远叫醒你。minutes 是 1–10080。why 必填，会写进下次醒来的纸上。返回 {target, until}。',
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          '要安静的来源："*"（全部环境噪音）或 "chat:<id>"——id 就是「能说话的地方」里那些数字。只有群里的闲话能压；私聊、@、回复永远叫醒你，所以 "dm" 不是合法 target。',
      },
      minutes: { type: "integer", minimum: 1, maximum: 10080, description: "安静多少分钟。" },
      why: { type: "string", description: "为什么。会写进你下次醒来的纸上。" },
    },
    required: ["target", "minutes", "why"],
  },
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

const proposeTool = tool({
  name: "propose",
  label: "Propose",
  description:
    "申请改自己的运行条件，下次醒来前生效。只认时机和阈值：" +
    '{"cycle":{"defaultWakeMinutes":30}}。容器限额、网络、timeout 不在这张桌子上。',
  parameters: {
    type: "object",
    properties: {
      value: { type: "string", description: '要改的东西，JSON 对象，形如 {"cycle":{"defaultWakeMinutes":30}}。' },
    },
    required: ["value"],
  },
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
  pi.registerTool(sayTool);
  pi.registerTool(listenTool);
  pi.registerTool(forgetTool);
  pi.registerTool(muteTool);
  pi.registerTool(proposeTool);
}
