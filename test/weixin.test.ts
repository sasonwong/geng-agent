import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  BUBBLE_LIMIT,
  chatIdFor,
  credentialsFile,
  mergeWeixin,
  readState,
  readWeixin,
  saveWeixin,
  writeState,
  type WeixinConfig,
  type WeixinState,
} from "../internal/channels/weixin/state.ts";
import { splitText, weixinChannel } from "../internal/channels/weixin/channel.ts";
import { systemFacts } from "../internal/packet.ts";
import { loginWeixin } from "../internal/channels/weixin/login.ts";
import type { Inbound, SendContext } from "../internal/channels/channel.ts";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "geng-weixin-"));
  mkdirSync(join(root, "data", "_gateway"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  return root;
}

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

type Answer = { body?: unknown; raw?: string; status?: number } | Promise<{ body?: unknown; raw?: string; status?: number }>;

async function fakeServer(handler: (req: Seen) => Answer): Promise<{
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        body = { _raw: text };
      }
      const call = { method: req.method ?? "", url: req.url ?? "", body };
      seen.push(call);
      void Promise.resolve(handler(call))
        .then((answer) => {
          res.statusCode = answer.status ?? 200;
          res.setHeader("content-type", "application/json");
          res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
        })
        .catch((err: unknown) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const NOW = Date.now();

function config(url: string, overrides: Partial<WeixinConfig> = {}): WeixinConfig {
  return {
    token: "ilinkbot_test",
    baseUrl: url,
    botId: "bot-1@im.bot",
    userId: "owner@im.wechat",
    ...overrides,
  };
}

function state(overrides: Partial<WeixinState> = {}): WeixinState {
  return {
    contextToken: "ctx-1",
    lastInboundAt: new Date(NOW).toISOString(),
    sentSinceInbound: 0,
    ...overrides,
  };
}

function sendContext(
  root: string,
  cfg: WeixinConfig,
  messages: string[],
  onSent: (part: { text: string }) => void = () => {},
  instance = "alice",
): SendContext {
  return {
    root,
    instance,
    cfg,
    chat: chatIdFor(cfg.userId as string),
    item: { file: join(root, "outbox", "1.json"), messages },
    steps: [],
    onSent,
    log: () => {},
    ops: () => {},
  };
}

test("a WeChat id is a safe negative chat id, stable, and parseable with a dash", () => {
  const a = chatIdFor("owner@im.wechat");
  const b = chatIdFor("someone@im.wechat");
  assert.ok(Number.isSafeInteger(a));
  assert.ok(a < 0);
  assert.ok(a > -8_100_000_000_000_000 && a <= -8_000_000_000_000_000);
  assert.notEqual(a, b);
  assert.equal(chatIdFor("owner@im.wechat"), a);
  // the inbox id is `<chat>-<nativeId>`; a negative chat id still splits on the last dash
  const id = `${a}-9007199254740993`;
  assert.equal(Number(id.slice(0, id.lastIndexOf("-"))), a);
});

test("splitText keeps 2000-character bubbles, prefers a paragraph, and never splits an emoji", () => {
  assert.deepEqual(splitText("a".repeat(4500)).map((s) => Array.from(s).length), [2000, 2000, 500]);
  const paragraph = `${"a".repeat(1000)}\n\n${"b".repeat(3000)}`;
  const parts = splitText(paragraph);
  assert.equal(parts[0], `${"a".repeat(1000)}\n\n`);
  assert.equal(parts.join(""), paragraph);
  const emoji = `${"😀".repeat(2500)}`;
  for (const part of splitText(emoji)) {
    assert.doesNotThrow(() => encodeURIComponent(part));
    assert.equal(Array.from(part).length <= 2000, true);
  }
  assert.equal(splitText("").length, 0);
});

test("a half-written weixin file keeps the old token and owner, and a new blank entry is dropped", () => {
  const running: Record<string, WeixinConfig> = {
    alice: { token: "old", userId: "owner", baseUrl: "https://a.example.invalid" },
  };
  const merged = mergeWeixin(running, {
    alice: { token: "", userId: "", baseUrl: "https://b.example.invalid" },
    bob: { token: "" },
  });
  assert.equal(merged.configs.alice?.token, "old");
  assert.equal(merged.configs.alice?.userId, "owner");
  assert.equal(merged.configs.alice?.baseUrl, "https://b.example.invalid");
  assert.equal(merged.configs.bob, undefined);
  assert.ok(merged.notes.some((n) => n.includes("沿用旧的")));
  assert.ok(merged.notes.some((n) => n.includes("跳过")));
});

test("credentials are written 600, and a blank token is reported instead of disappearing", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveWeixin(root, "alice", config("http://127.0.0.1:1"));
  assert.equal(statSync(credentialsFile(root)).mode & 0o777, 0o600);
  const read = readWeixin(root);
  assert.equal(read.problems.length, 0);
  assert.equal(read.configs.alice?.token, "ilinkbot_test");

  saveWeixin(root, "bob", { token: "", userId: "b@im.wechat" });
  const broken = readWeixin(root);
  assert.ok(broken.problems.some((p) => p.includes("bob") && p.includes("没有 token")));
});

test("an inbound owner message carries the context, opens the window, and keeps a uint64 id", async (t) => {
  const root = tempRoot();
  let polls = 0;
  const server = await fakeServer(() => {
    if (polls++ > 0) return { body: { ret: 0, msgs: [], get_updates_buf: "next-buf" } };
    // Built as text on purpose: a JS number literal is already rounded before JSON.stringify.
    const body = {
      ret: 0,
      msgs: [
        {
          seq: 1,
          message_id: 0,
          from_user_id: "owner@im.wechat",
          message_type: 1,
          create_time_ms: NOW,
          context_token: "ctx-2",
          item_list: [{ type: 1, text_item: { text: "你好" } }],
        },
        {
          seq: 2,
          message_id: 2,
          from_user_id: "stranger@im.wechat",
          message_type: 1,
          create_time_ms: NOW,
          context_token: "ctx-stranger",
          item_list: [{ type: 1, text_item: { text: "hi" } }],
        },
      ],
      get_updates_buf: "next-buf",
    };
    return { raw: JSON.stringify(body).replace('"message_id":0', '"message_id":9007199254740993') };
  });
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeState(root, { alice: state({ buf: "old-buf" }) });
  const cfg = config(server.url);
  const seen: Inbound[] = [];
  const ac = new AbortController();
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = weixinChannel.start({
    root,
    instance: "alice",
    cfg: () => cfg,
    chats: undefined,
    signal: ac.signal,
    log: () => {},
    ops: () => {},
    onInbound: async (msg) => {
      seen.push(msg);
      if (seen.length === 2) release();
    },
  });
  await both;
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  await run;

  assert.equal(seen.length, 2);
  const owner = seen[0] as Inbound;
  assert.equal(owner.channel, "weixin");
  assert.equal(owner.channelLabel, "微信");
  assert.equal(owner.nativeId, "9007199254740993");
  assert.equal(owner.chat, chatIdFor("owner@im.wechat"));
  assert.equal(owner.allowed, true);
  assert.equal(owner.text, "你好");
  assert.equal(owner.homeRank, 1);
  assert.equal(owner.canFile, false);
  assert.equal(owner.canQuote, false);
  const guest = seen[1] as Inbound;
  assert.equal(guest.allowed, false);
  assert.equal(guest.fromId, "stranger@im.wechat");

  const after = readState(root).alice as WeixinState;
  assert.equal(after.contextToken, "ctx-2");
  assert.equal(after.sentSinceInbound, 0);
  assert.equal(after.buf, "next-buf");
});

test("a new savedAt starts a new session: old cursor, context and window are dropped", async (t) => {
  const root = tempRoot();
  const server = await fakeServer(() => ({ body: { ret: 0, msgs: [], get_updates_buf: "server-buf" } }));
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeState(root, {
    alice: state({ savedAt: "old", buf: "old-buf", contextToken: "old-ctx", sentSinceInbound: 3, expiredAt: new Date(NOW).toISOString() }),
  });
  const cfg = { ...config(server.url), savedAt: "new" };
  const ac = new AbortController();
  const run = weixinChannel.start({
    root,
    instance: "alice",
    cfg: () => cfg,
    chats: undefined,
    signal: ac.signal,
    log: () => {},
    ops: () => {},
    onInbound: async () => {},
  });
  await new Promise((r) => setTimeout(r, 80));
  ac.abort();
  await run;
  const after = readState(root).alice as WeixinState;
  assert.equal(after.savedAt, "new");
  assert.equal(after.buf, "server-buf");
  assert.equal(after.contextToken, undefined);
  assert.equal(after.lastInboundAt, undefined);
  assert.equal(after.sentSinceInbound, undefined);
  assert.equal(after.expiredAt, undefined);
});

test("an empty cursor never erases the last good one", async (t) => {
  const root = tempRoot();
  const server = await fakeServer(() => ({ body: { ret: 0, msgs: [], get_updates_buf: "" } }));
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeState(root, { alice: state({ buf: "old-buf" }) });
  const ac = new AbortController();
  const run = weixinChannel.start({
    root,
    instance: "alice",
    cfg: () => config(server.url),
    chats: undefined,
    signal: ac.signal,
    log: () => {},
    ops: () => {},
    onInbound: async () => {},
  });
  await new Promise((r) => setTimeout(r, 80));
  ac.abort();
  await run;
  assert.equal(readState(root).alice?.buf, "old-buf");
});

test("ready answers the core before the brake: a closed window is not an attempt", (t) => {
  const closed = tempRoot();
  const open = tempRoot();
  t.after(() => {
    rmSync(closed, { recursive: true, force: true });
    rmSync(open, { recursive: true, force: true });
  });
  const cfg = config("http://127.0.0.1:1");
  writeState(closed, { alice: state({ lastInboundAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }) });
  assert.equal(weixinChannel.ready?.(sendContext(closed, cfg, ["等等"]))?.hold, true);
  writeState(open, { alice: state() });
  assert.equal(weixinChannel.ready?.(sendContext(open, cfg, ["现在"])), null);
});

test("send puts the latest context token on every bubble and records each one", async (t) => {
  const root = tempRoot();
  const server = await fakeServer(() => ({ body: {} }));
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeState(root, { alice: state() });
  const said: string[] = [];
  const outcome = await weixinChannel.send(
    sendContext(root, config(server.url), ["第一句", "第二句"], (part) => said.push(part.text)),
  );
  assert.equal(outcome.ack, true);
  assert.equal(outcome.sent, 2);
  assert.deepEqual(said, ["第一句", "第二句"]);
  const sends = server.seen.filter((s) => s.url === "/ilink/bot/sendmessage");
  assert.equal(sends.length, 2);
  for (const call of sends) {
    const msg = (call.body.msg ?? {}) as Record<string, unknown>;
    assert.equal(msg.context_token, "ctx-1");
    assert.equal(msg.to_user_id, "owner@im.wechat");
    assert.equal(msg.from_user_id, "");
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    const items = msg.item_list as { type: number; text_item: { text: string } }[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.type, 1);
  }
  assert.equal(readState(root).alice?.sentSinceInbound, 2);
});

test("a closed window, a full budget, or a missing context holds the whole item and sends nothing", async (t) => {
  // One root per case: the channel shares one state object per root, so a file written
  // behind its back in the same root is deliberately not re-read (the gateway reload does).
  const roots = [tempRoot(), tempRoot(), tempRoot(), tempRoot()];
  const server = await fakeServer(() => ({ body: {} }));
  t.after(async () => {
    await server.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  writeState(roots[0] as string, { alice: state({ lastInboundAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }) });
  let outcome = await weixinChannel.send(sendContext(roots[0] as string, config(server.url), ["晚了一步"]));
  assert.equal(outcome.hold, true);
  assert.equal(outcome.sent, 0);
  assert.equal(server.seen.length, 0);

  writeState(roots[1] as string, { alice: state({ sentSinceInbound: BUBBLE_LIMIT }) });
  outcome = await weixinChannel.send(sendContext(roots[1] as string, config(server.url), ["再来一句"]));
  assert.equal(outcome.hold, true);
  assert.equal(server.seen.length, 0);

  writeState(roots[2] as string, { alice: state({ sentSinceInbound: BUBBLE_LIMIT - 1 }) });
  outcome = await weixinChannel.send(sendContext(roots[2] as string, config(server.url), ["一", "二"]));
  assert.equal(outcome.hold, true);
  assert.equal(server.seen.length, 0);

  writeState(roots[3] as string, { alice: state({ sentSinceInbound: BUBBLE_LIMIT - 1 }) });
  outcome = await weixinChannel.send(sendContext(roots[3] as string, config(server.url), ["刚好一条"]));
  assert.equal(outcome.ack, true);
  assert.equal(server.seen.length, 1);
});

test("ret=-2 holds, ret=-14 marks the session expired and stops", async (t) => {
  const root = tempRoot();
  let reply: Record<string, unknown> = { ret: -2 };
  const server = await fakeServer(() => ({ body: reply }));
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeState(root, { alice: state() });

  let outcome = await weixinChannel.send(sendContext(root, config(server.url), ["等一下"]));
  assert.equal(outcome.hold, true);
  assert.equal(readState(root).alice?.sentSinceInbound, 0);

  reply = { ret: -14, errmsg: "session timeout" };
  outcome = await weixinChannel.send(sendContext(root, config(server.url), ["过期了"]));
  assert.equal(outcome.hold, true);
  assert.ok(outcome.error instanceof Error);
  assert.equal(typeof readState(root).alice?.expiredAt, "string");
});

test("a QR login writes the credential 600, prints the link, and leaves the session to the gateway", async (t) => {
  const root = tempRoot();
  const server = await fakeServer((req) => {
    if (req.url.includes("get_bot_qrcode")) {
      return { body: { ret: 0, qrcode: "qr-1", qrcode_img_content: "https://example.invalid/qr" } };
    }
    if (req.url.includes("get_qrcode_status")) {
      return {
        body: {
          ret: 0,
          status: "confirmed",
          bot_token: "ilinkbot_new",
          ilink_bot_id: "new@im.bot",
          ilink_user_id: "owner@im.wechat",
          baseurl: server.url,
        },
      };
    }
    return { body: {} };
  });
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  saveWeixin(root, "alice", config(server.url, { token: "old-token" }));
  writeState(root, { alice: state({ expiredAt: new Date(NOW).toISOString() }) });
  const lines: string[] = [];
  const ac = new AbortController();
  await loginWeixin({
    root,
    instance: "alice",
    baseUrl: server.url,
    name: "主人",
    log: (line) => lines.push(line),
    signal: ac.signal,
  });
  const cfg = readWeixin(root).configs.alice as WeixinConfig;
  assert.equal(cfg.token, "ilinkbot_new");
  assert.equal(cfg.userId, "owner@im.wechat");
  assert.equal(cfg.botId, "new@im.bot");
  assert.equal(cfg.name, "主人");
  assert.equal(statSync(credentialsFile(root)).mode & 0o777, 0o600);
  // The login owns secrets/; data/_gateway/weixin.json is the gateway's, and the new
  // savedAt is what makes the next start drop the old session.
  assert.equal(typeof readState(root).alice?.expiredAt, "string");
  assert.ok(lines.some((l) => l.includes("https://example.invalid/qr")));
  const qr = server.seen.find((s) => s.url.includes("get_bot_qrcode"));
  assert.deepEqual(qr?.body.local_token_list, ["old-token"]);
});

test("a re-scan of an already bound bot bumps savedAt, so a reload restarts the same token", async (t) => {
  const root = tempRoot();
  const server = await fakeServer((req) => {
    if (req.url.includes("get_bot_qrcode")) return { body: { ret: 0, qrcode: "qr-2", qrcode_img_content: "qr-2" } };
    if (req.url.includes("get_qrcode_status")) return { body: { ret: 0, status: "binded_redirect" } };
    return { body: {} };
  });
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  saveWeixin(root, "alice", config(server.url));
  writeState(root, { alice: state({ expiredAt: new Date(NOW).toISOString() }) });
  const before = readWeixin(root).configs.alice as WeixinConfig;
  const ac = new AbortController();
  await loginWeixin({ root, instance: "alice", baseUrl: server.url, log: () => {}, signal: ac.signal });
  const after = readWeixin(root).configs.alice as WeixinConfig;
  assert.equal(after.token, before.token);
  assert.notEqual(weixinChannel.fingerprint(after), weixinChannel.fingerprint(before));
  assert.equal(typeof after.savedAt, "string");
  assert.equal(typeof readState(root).alice?.expiredAt, "string");
});

test("doctor is silent when unconfigured, and names a duplicate token and an expired session", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(weixinChannel.doctor?.(root, "alice"), []);

  saveWeixin(root, "alice", config("http://127.0.0.1:1"));
  saveWeixin(root, "bob", config("http://127.0.0.1:1"));
  writeState(root, { alice: state({ expiredAt: new Date(NOW).toISOString() }) });
  const checks = weixinChannel.doctor?.(root, "alice") ?? [];
  assert.ok(checks.some((c) => c.name === "微信重复绑定" && !c.ok && c.detail.includes("bob")));
  assert.ok(checks.some((c) => c.name === "微信会话" && !c.ok && c.detail.includes("过期")));
  // bob is also configured; its own doctor must still see the duplicate, not only alice
  assert.ok((weixinChannel.doctor?.(root, "bob") ?? []).some((c) => c.name === "微信重复绑定" && !c.ok));
});

test("the page tells a waking that a WeChat place can only reply inside the window", () => {
  const weixin = systemFacts(
    [{ id: chatIdFor("owner@im.wechat"), label: "微信 私聊 主人", home: true, channel: "weixin" }],
    "x",
    30,
  );
  assert.match(weixin, /微信只能回：主人说话后 24 小时内/);
  const telegram = systemFacts([{ id: 1, label: "telegram 私聊", home: true }], "x", 30);
  assert.doesNotMatch(telegram, /微信只能回/);
});

test("a blank token is a doctor failure", (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveWeixin(root, "alice", { token: "", userId: "owner@im.wechat" });
  const checks = weixinChannel.doctor?.(root, "alice") ?? [];
  assert.ok(checks.some((c) => c.name === "微信凭据" && !c.ok));
});
