import { join } from "node:path";
import { Tripwire } from "./tripwire.ts";
import { ExpectedError } from "./errors.ts";
import type { Paths } from "./paths.ts";
import { makePaths } from "./paths.ts";
import { appendSaid } from "./people.ts";
import { newestKnock, peekInbox } from "./inbox.ts";
import { describeConfig, loadMailConfig, readMailEnv, startMailServer } from "./mail.ts";
import {
  ackOutbox,
  ensureGatewayDirs,
  outboxDir,
  readOutbox,
  trimOutbox,
  writeOps,
  type OutboxItem,
} from "./mute.ts";
import { readJson } from "./fs.ts";
import { CHANNEL_BY_ID, CHANNELS } from "./channels/index.ts";
import {
  failedAttempt,
  handleInbound,
  readChats,
  reloadPlan,
  sendPlan,
  type InboundHost,
} from "./channels/core.ts";
import type { Channel, Place, SendResult } from "./channels/channel.ts";

export {
  alreadyStored,
  failedAttempt,
  HANDLE_ATTEMPTS,
  noteChat,
  readChats,
  reloadPlan,
  route,
  SEND_ATTEMPTS,
  sendPlan,
  storeRemoteAttachment,
  targetChat,
} from "./channels/core.ts";
export { mergeBots } from "./channels/telegram.ts";
export type { Chats, KnownChat } from "./channels/channel.ts";

export interface GatewayOptions {
  root: string;
  log?: (line: string) => void;
}

/** What the daemon shows the agent about where it may speak. */
export function knownPlaces(root: string, key: string): Place[] {
  const chats = readChats(join(root, "data", "_gateway", "chats.json"))[key];
  if (!chats) return [];
  const home = chats.home;
  return Object.entries(chats.known ?? {}).map(([id, c]) => ({
    id: Number(id),
    label:
      c.kind === "private"
        ? `${c.label ? `${c.label} ` : ""}私聊${c.who ? ` ${c.who}` : ""}`
        : `${c.label ? `${c.label} ` : ""}群「${c.title ?? id}」`,
    home: Number(id) === home,
    kind: c.kind,
    // files written before the channel contract existed are Telegram's, where both hold
    channel: c.channel ?? "telegram",
    canFile: c.canFile ?? true,
    canQuote: c.canQuote ?? true,
  }));
}

/**
 * The brake's numbers. The window/limit/pause live here; the recording lives in
 * internal/tripwire.ts, because the order of "look at the pause" vs "record an attempt"
 * is the whole difference between a brake and a lockup.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const REPEAT_LIMIT = 10;
const PAUSE_MS = 10 * 60_000;

/**
 * `geng-gateway.service` sets NODE_USE_ENV_PROXY=1 so `fetch` honours the HTTP(S)_PROXY in
 * secrets/gateway.env. Node only began reading that switch in 22.21.0 / 24.0.0 (23 never
 * had it); on an older runtime the variable is silently ignored and the gateway goes out
 * directly — which looks exactly like "Telegram is down" while every setting is right.
 */
export function assertProxySupport(
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
): void {
  const configured = [
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  ].some((key) => (env[key] ?? "") !== "");
  if (!configured) return;
  const [major = NaN, minor = NaN] = nodeVersion.split(".").map(Number);
  if (major >= 24 || (major === 22 && minor >= 21)) return;
  throw new ExpectedError(
    `配了 HTTP(S)_PROXY，但这台机器的 Node ${nodeVersion} 不认 NODE_USE_ENV_PROXY：` +
      "要 22.21.0 或 24 以上。否则网关会绕过代理直连，看起来就像 Telegram 挂了。",
  );
}

export async function runGateway(o: GatewayOptions): Promise<void> {
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));
  assertProxySupport();
  const root = o.root;

  // Every channel reads its own secrets file. A channel that cannot parse its file says
  // so and keeps what it could; none of them may take another channel down.
  const configs: Record<string, Record<string, unknown>> = {};
  for (const channel of CHANNELS) {
    const loaded = channel.load(root);
    for (const problem of loaded.problems) log(`${channel.id}：${problem}`);
    configs[channel.id] = loaded.configs;
  }
  // a mailbox is a transport too: an instance may have mail and no chat channel
  const loadedMail = loadMailConfig(root);
  // a box rather than a bare `let`: the getter handed to the mail server stays non-null
  // for the life of the process, and only its contents are swapped by a reload
  const mailbox = loadedMail === null ? null : { cfg: loadedMail };
  if (!CHANNELS.some((channel) => Object.keys(configs[channel.id] ?? {}).length > 0) && mailbox === null) {
    throw new ExpectedError(
      `没有渠道也没有信箱：先写 ${join(root, "secrets", "bots.json")}、${join(root, "secrets", "weixin.json")} 或 ${join(root, "secrets", "mail.json")}`,
    );
  }

  const { ops } = ensureGatewayDirs(root);
  const chatsFile = join(root, "data", "_gateway", "chats.json");
  const chats = readChats(chatsFile);
  const watch = new Map<string, Tripwire>();

  const watchFor = (key: string): Tripwire => {
    let w = watch.get(key);
    if (!w) {
      w = new Tripwire({ windowMs: RATE_WINDOW_MS, rate: RATE_LIMIT, repeat: REPEAT_LIMIT, pauseMs: PAUSE_MS });
      watch.set(key, w);
    }
    return w;
  };

  /** Tripwires look only at shape — rate and repetition. Never at meaning. */
  const trip = (key: string, texts: string[]): string | null => {
    const w = watchFor(key);
    const verdict = w.check(texts, Date.now());
    if (verdict === "rate") {
      writeOps(ops, "gateway", `${key} 在 1 分钟内要发 ${w.attempts} 条，暂停投递 10 分钟。消息没丢。`);
    } else if (verdict === "repeat") {
      writeOps(ops, "gateway", `${key} 连续发了同一句话 ${REPEAT_LIMIT} 次，暂停投递 10 分钟。消息没丢。`);
    }
    return verdict;
  };

  const instanceData = (key: string): Paths | null => {
    try {
      return makePaths(root, key);
    } catch {
      return null;
    }
  };

  // One place where an inbound message lands, whichever channel carried it.
  const inboundHost: InboundHost = {
    root,
    chats,
    chatsFile,
    ops,
    log,
    instanceData,
  };

  const sendItem = async (key: string, item: OutboxItem): Promise<SendResult> => {
    const channelId = item.channel ?? "telegram";
    const channel = CHANNEL_BY_ID[channelId];
    if (!channel) {
      writeOps(ops, "gateway", `${key} 要发到未知通道 ${channelId}，没发。`);
      return { ack: true, sent: 0, error: null };
    }
    const cfg = configs[channelId]?.[key];
    if (!cfg) return { ack: false, sent: 0, error: null };
    const p = instanceData(key);
    if (!p) {
      writeOps(ops, "gateway", `收到发给未知实例 ${key} 的消息，已忽略。`);
      return { ack: true, sent: 0, error: null };
    }
    const mine = chats[key];
    const chat = item.chat ?? channel.defaultChat?.(cfg, mine) ?? mine?.home;
    if (chat === undefined) {
      // Not a failure to retry: the sweep hands this back every two seconds and nothing
      // will have changed. Acknowledged, with one line, because the words were queued as
      // if they had somewhere to go and that is the part a person has to be told.
      writeOps(
        ops,
        "gateway",
        `${key} 没有地方可发：配置里没写 chat，也还没有人跟这个通道说过话。这条没送到，文件在 outbox/sent/ 里。`,
      );
      return { ack: true, sent: 0, error: null };
    }
    if (item.chat !== undefined && !mine?.known?.[String(item.chat)]) {
      writeOps(ops, "gateway", `${key} 要发给不认识的 chat ${item.chat}，没发。`);
      return { ack: true, sent: 0, error: null }; // acknowledged: retrying will never make it known
    }
    const { steps, refused } = sendPlan(p.workspace, item.files ?? [], item.attachments ?? []);
    const sendCtx = {
      root,
      instance: key,
      cfg,
      chat,
      item,
      steps,
      ...(item.replyTo === undefined ? {} : { replyTo: item.replyTo }),
      onSent: (part: { text: string; nativeId?: string }) => {
        appendSaid(p.data, chat, {
          at: new Date().toISOString(),
          dir: "out",
          text: part.text,
          ...(part.nativeId === undefined ? {} : { id: `${chat}-${part.nativeId}` }),
        });
      },
      log,
      ops: (line: string) => writeOps(ops, "gateway", line),
    };
    // A channel that is waiting (a window, a quota) must not be counted as an attempt:
    // the sweep hands the same item back every two seconds and would trip its own brake.
    const early = channel.ready?.(sendCtx) ?? null;
    if (early !== null) return early;
    for (const given of refused) {
      writeOps(ops, "gateway", `${key} 想发 ${given}，那不是 /work 里的文件，没发。`);
    }
    if (trip(key, item.messages)) return { ack: false, sent: 0, error: null };
    try {
      return await channel.send(sendCtx);
    } catch (err) {
      // a channel reports its own failures; a throw here is only the unexpected
      return { ack: false, sent: 0, error: err as Error };
    }
  };

  // One long poll per instance per channel, keyed so a reload can stop exactly the one it
  // has to. Telegram allows one consumer per token: a changed token means the old poll
  // must end before the new one starts, or both get 409 and the bot looks dead.
  const pollers = new Map<string, { fingerprint: string; stop: () => Promise<void> }>();

  // one reload at a time: two SIGHUPs a second apart must not stop the same poller twice.
  // A SIGHUP that arrives mid-reload leaves a mark and gets its own pass afterwards, so
  // an edit made during a reload is read instead of being silently lost.
  let reloading: Promise<void> | null = null;
  let reloadAgain = false;

  /**
   * Nothing left to serve means exit, not "stay alive and look healthy". A bad token used
   * to leave the process holding a promise that never settles: systemd said active and
   * only journald knew. Exiting makes the unit retry, which is what a wrong token needs.
   *
   * A mailbox is still a job, and a reload is momentarily between stop and start — exiting
   * there would turn one config edit into a restart loop.
   */
  const exitIfIdle = (): void => {
    if (pollers.size > 0 || mailbox !== null || reloading !== null) return;
    log("没有轮询也没有信箱：退出，unit 会重试");
    process.exit(1);
  };

  const startPoller = (channel: Channel, key: string): void => {
    const id = `${channel.id}:${key}`;
    const initial = configs[channel.id]?.[key];
    if (!initial || pollers.has(id)) return;
    const ac = new AbortController();
    const done = channel
      .start({
        root,
        instance: key,
        // read per message: an allow/listen edit must take effect without dropping the poll
        cfg: () => configs[channel.id]?.[key] ?? initial,
        chats: chats[key],
        signal: ac.signal,
        log,
        ops: (line) => writeOps(ops, "gateway", line),
        onInbound: (msg) => handleInbound(inboundHost, key, msg),
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // this entry is still in the map here, so more than one means another poller is
        // alive; exitIfIdle will then not exit, and nothing else ever restarts this one
        const line = `${channel.id}/${key} 的轮询断了：${(err as Error).message}${
          pollers.size > 1 ? "（别的渠道还在跑，它要 reload 一次才回来）" : ""
        }`;
        log(line);
        // the same fact in the only place a person looks: journald alone is not a signal
        writeOps(ops, "gateway", line);
      });
    const entry = {
      fingerprint: channel.fingerprint(initial),
      stop: async () => {
        ac.abort();
        await done;
      },
    };
    pollers.set(id, entry);
    // a poller that died on its own (a token that was wrong at startup) must be startable
    // again by the next reload, so it leaves the map when its loop ends
    void done.finally(() => {
      if (pollers.get(id) === entry) pollers.delete(id);
      exitIfIdle();
    });
  };

  const stopPoller = async (id: string): Promise<void> => {
    const p = pollers.get(id);
    if (!p) return;
    await p.stop();
    if (pollers.get(id) === p) pollers.delete(id);
  };

  const readMail = (): void => {
    const next = loadMailConfig(root);
    if (next === null) {
      // empty or unreadable is a typo, not an instruction: a mailbox is not torn down by
      // a half-written file, and stopping one is a restart
      if (mailbox !== null) {
        log(`重载：mail.json 是空的或读不出来，继续用旧的 ${Object.keys(mailbox.cfg).length} 个地址`);
      }
      return;
    }
    if (mailbox === null) {
      log("重载：新出现了 mail.json，但信箱是启动时起的——重启才起得来");
      return;
    }
    mailbox.cfg = next;
    for (const line of describeConfig(mailbox.cfg)) log(`mail 重载：${line}`);
  };

  const doReload = async (): Promise<void> => {
    for (const channel of CHANNELS) {
      const next = channel.load(root);
      for (const problem of next.problems) log(`${channel.id}：${problem}`);
      if (Object.keys(next.configs).length === 0) {
        log(`重载：${channel.id} 是空的或读不出来，一个都没动`);
        continue;
      }
      const merged = channel.merge(configs[channel.id] ?? {}, next.configs);
      for (const line of merged.notes) log(line);
      const fingerprints = (m: Record<string, unknown>): Record<string, string> =>
        Object.fromEntries(Object.entries(m).map(([key, cfg]) => [key, channel.fingerprint(cfg)]));
      const plan = reloadPlan(fingerprints(configs[channel.id] ?? {}), fingerprints(merged.configs));
      // stop, swap, start: the new poller must read the new token, and the old one has to
      // be gone before it starts polling or both get 409
      for (const key of plan.stop) await stopPoller(`${channel.id}:${key}`);
      configs[channel.id] = merged.configs;
      for (const key of plan.start) startPoller(channel, key);
      log(
        `重载：${channel.id} ${Object.keys(merged.configs).length} 个（起 ${plan.start.length} 停 ${plan.stop.length}）`,
      );
      for (const [key, cfg] of Object.entries(merged.configs)) {
        const detail = channel.describe?.(key, cfg, chats[key]);
        log(`重载 ${channel.id}/${key}：${detail ?? "已配置"}`);
      }
    }
    readMail();
  };

  const reload = (): Promise<void> => {
    if (reloading !== null) {
      reloadAgain = true;
      return reloading;
    }
    const pass = async (): Promise<void> => {
      do {
        reloadAgain = false;
        await doReload().catch((err: unknown) => log(`重载失败：${(err as Error).message}`));
      } while (reloadAgain);
    };
    reloading = pass().finally(() => {
      reloading = null;
      // a SIGHUP that landed between the last loop check and here must not be swallowed
      if (reloadAgain) {
        void reload();
        return;
      }
      // checked here and not inside doReload: there `reloading` is still set, so the guard
      // that protects the stop/start window would swallow a reload that emptied the table
      exitIfIdle();
    });
    return reloading;
  };
  // before anything is awaited: SIGHUP's default action is to kill the process, and a
  // reload arriving during startup would look exactly like a crash
  process.on("SIGHUP", () => {
    log("收到 SIGHUP：重读渠道配置和 mail.json");
    void reload();
  });

  // "working on it" is worth 4 seconds of a person's patience at a time; the state is
  // deliberately in memory, because a gateway restart should just stop typing.
  const typedAt = new Map<string, number>();
  const TYPING_REFRESH_MS = 4_000;

  const showTyping = async (key: string): Promise<void> => {
    const p = instanceData(key);
    if (!p) return;
    // intent.json exists exactly while a waking is in flight, and only then is anybody
    // waiting for an answer
    const intent = readJson<{ startedAt?: string } | null>(p.intent, null);
    if (intent === null) return;
    const since = Date.parse(intent.startedAt ?? "");
    if (Number.isFinite(since) && Date.now() - since > 30 * 60_000) return; // a dead cycle must not type forever
    const knock = newestKnock(peekInbox(p.inbox));
    if (!knock || typeof knock.chat !== "number") return;
    const chat = knock.chat;
    const channelId = chats[key]?.known?.[String(chat)]?.channel ?? "telegram";
    const channel = CHANNEL_BY_ID[channelId];
    const cfg = configs[channelId]?.[key];
    if (!channel?.typing || !cfg) return;
    const stamp = `${channelId}:${key}`;
    const last = typedAt.get(stamp) ?? 0;
    if (Date.now() - last < TYPING_REFRESH_MS) return;
    typedAt.set(stamp, Date.now());
    try {
      await channel.typing({ root, instance: key, cfg, chat });
    } catch {
      // a status is not worth failing the sweep over
    }
  };

  // One count per outbox item, in memory on purpose: a restart is a fresh set of attempts.
  const sendFailures = new Map<string, number>();

  const sweep = async (): Promise<void> => {
    for (;;) {
      // read per pass: a reload may have added or removed an instance since the last one
      const keys = new Set<string>();
      for (const channel of CHANNELS) {
        for (const key of Object.keys(configs[channel.id] ?? {})) keys.add(key);
      }
      for (const key of keys) {
        try {
          await showTyping(key);
        } catch {
          // ignore
        }
        const dir = key === "ops" ? outboxDir(join(root, "data", "_ops")) : outboxDir(join(root, "data", key));
        for (const item of readOutbox(dir)) {
          if (item.messages.length === 0) {
            ackOutbox(dir, item.file);
            continue;
          }
          let outcome: SendResult;
          try {
            outcome = await sendItem(key, item);
          } catch (err) {
            // sendItem reports its own failures; a throw here is only the unexpected
            outcome = { ack: false, sent: 0, error: err as Error };
          }
          // What went out leaves the queue: a retry says only the rest, not the parts
          // already delivered (and already in the transcript).
          if (outcome.sent > 0 || outcome.left !== undefined) trimOutbox(item.file, outcome.sent, outcome.left);
          if (outcome.hold) continue;
          if (outcome.ack) {
            ackOutbox(dir, item.file);
            sendFailures.delete(item.file);
          } else if (outcome.error !== null) {
            // Left in the queue until the attempts run out: acknowledging here is what
            // made a two-second blip lose words for good.
            const { n, giveUp } = failedAttempt(sendFailures, item.file);
            if (!giveUp) continue;
            writeOps(
              ops,
              "gateway",
              `发给 ${key} 失败 ${n} 次，放弃了：${outcome.error.message}。那条消息在 outbox/sent/ 里，没送到。`,
            );
            ackOutbox(dir, item.file);
            sendFailures.delete(item.file);
          }
        }
      }
      await new Promise<void>((r) => setTimeout(r, 2_000));
    }
  };

  if (mailbox !== null) {
    const mailEnv = readMailEnv(root);
    // a mailbox is a second transport: a field missing here must not take the chat
    // channels down with it, and it must not be quiet either — ops is the only place a
    // person looks
    const broken = (why: string): void => {
      const line = `信箱没起来：${why}。别的渠道照常。`;
      log(line);
      writeOps(ops, "gateway", line);
    };
    if (mailEnv === null) {
      broken(`有 ${join("secrets", "mail.json")} 但没有 token（secrets/mail.env 的 GENG_MAIL_TOKEN）`);
    } else {
      try {
        await startMailServer({ root, getCfg: () => mailbox.cfg, env: mailEnv, log });
        for (const line of describeConfig(mailbox.cfg)) log(`mail 上线：${line}`);
      } catch (err) {
        broken((err as Error).message);
      }
    }
  }

  void sweep();
  for (const channel of CHANNELS) {
    for (const key of Object.keys(configs[channel.id] ?? {})) startPoller(channel, key);
  }
  // the pollers come and go on reload, so what keeps this process alive is the promise
  // that never settles — not a list of loops captured at startup
  await new Promise<void>(() => {});
}
