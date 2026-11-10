import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { listSnapshots, restore, restoredLooksWhole, rusticAvailable } from "./backup.ts";
import { formatDuration } from "./schedule.ts";
import { readJson, readText } from "./fs.ts";
import { readBots, botIssues, type BotIssue } from "./bots.ts";
import { loadMailConfig, readMailEnv } from "./mail.ts";
import { mailWiringProblem, readEnvFile } from "./secret.ts";
import { readSearchEnv, searchQuota } from "./search.ts";
import { chainFrom } from "./proxy.ts";
import { makeJwt, readGhApp } from "./ghapp.ts";
import { MODEL_KEY_VARS, modelKeyFile, modelUpstream, readChain, readModelKey, readProviders } from "./model.ts";
import { buildCommand, listSessionFiles } from "./command.ts";
import { socketPath } from "./book.ts";
import { CHANNELS } from "./channels/index.ts";
import { makePaths } from "./paths.ts";
import { loadPolicy, policyDrift, templateValue, type Policy } from "./policy.ts";
import { repairTail } from "./session.ts";
import { onDiskSchema, schemaConflict, STATE_SCHEMA } from "./schema.ts";

function readdirSafe(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warnOnly?: boolean;
}

function hasCmd(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface V4Range {
  low: number;
  high: number;
}

/**
 * An IPv4 CIDR as a closed numeric range, for the only question that needs arithmetic:
 * does an allow rule leave any part of a dangerous range reachable? Only the IPv4-mapped
 * block of IPv6 reaches IPv4 space; anything else in v6 is not this list's business.
 */
function v4Range(entry: string): V4Range | null {
  let net: string;
  let prefix: number;
  if (entry.includes(":")) {
    const dotted = /^::ffff:(\d+(?:\.\d+){3})(?:\/(\d+))?$/.exec(entry);
    if (dotted !== null) {
      net = dotted[1] as string;
      prefix = dotted[2] === undefined ? 128 : Number(dotted[2]);
    } else if (entry === "::ffff:0:0/96") {
      net = "0.0.0.0";
      prefix = 96;
    } else {
      return null;
    }
    if (prefix < 96) return null;
    prefix -= 96;
  } else {
    const [n, p] = entry.split("/");
    net = n ?? "";
    prefix = p === undefined ? 32 : Number(p);
  }
  const octets = net.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const base =
    (((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number)) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const low = (base & mask) >>> 0;
  // complement written as an XOR, not `~mask`: a tilde before a word reads as a home
  // directory to the gate, and correctly so — nothing else in this repo writes one
  return { low, high: (low | (mask ^ 0xffffffff)) >>> 0 };
}

const inRange = (ip: number, r: V4Range): boolean => ip >= r.low && ip <= r.high;

/**
 * Whether any part of `danger` stays reachable under the rules: the allow entries that
 * overlap it, minus every deny entry, measured rather than guessed. Probing only the
 * range's base address let `127.0.1.0/24` hide — it does not contain `127.0.0.1`, but it
 * is loopback all the same.
 */
function rangeOpenUnder(danger: string, rules: string[]): boolean {
  const d = v4Range(danger);
  if (d === null) return false;
  const denyRanges = rules
    .filter((r) => r.startsWith("!"))
    .map((r) => v4Range(r.slice(1)))
    .filter((r): r is V4Range => r !== null);
  for (const raw of rules) {
    if (raw.startsWith("!")) continue; // a deny closes, it never opens
    const a = v4Range(raw);
    if (a === null) continue;
    const low = Math.max(a.low, d.low);
    const high = Math.min(a.high, d.high);
    if (low > high) continue;
    // The uncovered part of [low, high] has its boundaries among these points, so testing
    // them is testing the whole set: each deny contributes its own edges and neighbours.
    const points = new Set<number>([low, high]);
    for (const n of denyRanges) {
      for (const edge of [n.low, n.high, n.low - 1, n.high + 1]) {
        if (edge >= low && edge <= high) points.add(edge);
      }
    }
    for (const ip of points) {
      if (!denyRanges.some((n) => inRange(ip, n))) return true;
    }
  }
  return false;
}

/**
 * The four variables git reads before any config. Three states, because a missing identity
 * fails loudly ("Author identity unknown") where a wrong one does not: the app id in the
 * address pushes fine and the commit arrives with no author at all. Both numbers are in
 * this same env file, so this is the one comparison that can be made offline.
 */
export function gitIdentity(
  env: Record<string, string>,
  appId: string,
): { ok: boolean; missing: boolean; detail: string } {
  const vars = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const set = vars.filter((k) => (env[k] ?? "") !== "");
  const name = env["GIT_AUTHOR_NAME"] ?? "";
  const emails = [env["GIT_AUTHOR_EMAIL"] ?? "", env["GIT_COMMITTER_EMAIL"] ?? ""];
  if (set.length === 0) {
    return {
      ok: false,
      missing: true,
      detail:
        "没配（GIT_AUTHOR_* / GIT_COMMITTER_*）：clone 里配过就用 clone 的，都没配时 git commit 会直接报 Author identity unknown",
    };
  }
  if (set.length < vars.length) {
    const absent = vars.filter((k) => !set.includes(k));
    return {
      ok: false,
      missing: false,
      detail: `只配了 ${set.join("、")}：还缺 ${absent.join("、")}，它会落到 clone 的 user.* 或 ~/.gitconfig——可能记到别人名下`,
    };
  }
  if (appId !== "" && emails.some((e) => e.startsWith(`${appId}+`))) {
    return {
      ok: false,
      missing: false,
      detail: `邮箱里的数字是 App ID ${appId}，不是 bot 用户 id：push 会成功，提交在网页上没有作者——该写 <bot 用户 id>+<slug>[bot]@users.noreply.github.com`,
    };
  }
  return { ok: true, missing: false, detail: `${name} <${emails[0]}>` };
}

export function checkInstance(root: string, instance: string, fix: boolean): Check[] {
  const p = makePaths(root, instance);
  const checks: Check[] = [];

  checks.push({ name: "data 目录", ok: existsSync(p.data), detail: p.data });

  // "active (running)" is not evidence of anything: a unit that restarts every 16s is
  // also active. Only a counter says so, and this is where the crash loop was invisible.
  try {
    const n = Number(
      execFileSync("systemctl", ["--user", "show", `geng@${instance}`, "-p", "NRestarts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .replace("NRestarts=", ""),
    );
    checks.push({
      name: "守护进程重启",
      ok: !Number.isFinite(n) || n < 20,
      warnOnly: true,
      detail: n >= 20 ? `重启了 ${n} 次，它可能在崩溃循环里——看 journalctl --user -u geng@${instance}` : `${n} 次`,
    });
  } catch {
    checks.push({ name: "守护进程重启", ok: true, warnOnly: true, detail: "没装成 user 单元，跳过" });
  }

  let policy;
  try {
    policy = loadPolicy(p.policy);
    checks.push({ name: "policy 解析", ok: true, detail: `镜像 ${policy.container.image}` });
  } catch (err) {
    checks.push({ name: "policy 解析", ok: false, detail: (err as Error).message });
    return checks;
  }

  // The copy is frozen at `init`. A key the template has and this file lacks means the
  // instance is running on a default nobody chose; a key the template dropped is dead
  // weight that still reads like configuration.
  const policyTemplate = readJson<Record<string, unknown>>(join(root, "deploy", "policy.json"), {});
  const copy = readJson<Record<string, unknown>>(p.policy, {});
  const drift = policyDrift(policyTemplate, copy);
  const describe = (key: string): string => {
    const value = templateValue(policyTemplate, key);
    if (value === undefined) return key;
    // a twelve-entry default printed in full is a wall of text in a one-line table
    const shown = Array.isArray(value) ? `[${value.length} 项]` : JSON.stringify(value);
    return `${key}=${shown}`;
  };
  checks.push({
    name: "policy 跟模板",
    ok: drift.missing.length === 0 && drift.stale.length === 0,
    warnOnly: true,
    detail:
      drift.missing.length === 0 && drift.stale.length === 0
        ? "一致"
        : [
            drift.missing.length > 0 ? `缺（正在用默认值）：${drift.missing.map(describe).join("、")}` : "",
            drift.stale.length > 0 ? `多余（没人再读）：${drift.stale.join("、")}` : "",
          ]
            .filter((x) => x !== "")
            .join("；"),
  });

  const settings = readJson<{
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
    packages?: unknown;
  }>(join(p.piDir, "settings.json"), {});
  checks.push({
    name: "容器 settings",
    ok: typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string",
    detail:
      typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : `${join(p.piDir, "settings.json")} 里没有 defaultProvider/defaultModel：容器连不上模型`,
  });

  // The image installs the packages; this file decides which are loaded. They are two
  // copies of one list, and the copy made at init does not follow the template: a package
  // declared here but never installed makes pi exit before it can say anything.
  const template = readJson<{ packages?: unknown }>(join(root, "deploy", "settings.json"), {});
  const listed = Array.isArray(settings.packages) ? settings.packages.filter((x): x is string => typeof x === "string") : [];
  const templated = Array.isArray(template.packages)
    ? template.packages.filter((x): x is string => typeof x === "string")
    : [];
  const missing = listed.filter((x) => !templated.includes(x));
  checks.push({
    name: "插件列表",
    ok: missing.length === 0,
    warnOnly: true,
    detail:
      missing.length === 0
        ? listed.length === 0
          ? "只装镜像里自带的那几个"
          : listed.join(", ")
        : `这份 settings 里写了镜像没装的：${missing.join(", ")}——镜像里没有，醒来会直接退出`,
  });

  // The key must not be in the env file: that file is `--env-file` into the container,
  // and a round that runs `env` would read it. This is the migration check, not a nicety.
  const key = readModelKey(p);
  const envVars = readEnvFile(p.secrets);
  // The list readModelKey would accept, not a copy of it: a sixth spelling added there and
  // not here leaves the migration check silently blind to exactly the name it is for.
  const namedInEnv = MODEL_KEY_VARS.filter((name) => (envVars[name] ?? "") !== "");
  // Both halves are needed now that the daemon is the data plane: without an upstream the
  // proxy answers 503 and every model request fails with what looks like a network error.
  const upstream = modelUpstream(p);
  const providers = readProviders(p);
  const chain = readChain(p);
  const head = chain.chain[0];
  // The address comes from the provider table when it knows this provider, and from the
  // old single-upstream variable otherwise: file over environment, one order, said out loud.
  const named = head?.provider ?? settings.defaultProvider;
  const fromTable = named === undefined ? undefined : providers.table[named];
  const address = fromTable?.url ?? upstream;
  checks.push({
    name: "模型密钥",
    ok: key !== null && namedInEnv.length === 0 && address !== null,
    detail:
      key === null
        ? `没有 ${modelKeyFile(p)}：第一轮就会没有模型可用`
        : namedInEnv.length > 0
          ? `${namedInEnv.join("、")} 写在 ${p.secrets} 里——那个文件会进容器，挪到 secrets/<实例>.model.env`
          : address === null
            ? "没有 GENG_MODEL_UPSTREAM，deploy/providers.json 里也没有这个 provider：代理不知道往哪转发，每次请求都 503"
            : `${key.name} → ${address}（${fromTable ? `deploy/providers.json 的 ${named}` : "GENG_MODEL_UPSTREAM"}，都在宿主上，容器只是问）`,
  });

  // Without this, "no fallback" and "a fallback that is never reached" look identical from
  // the daemon's side: nothing happens either way. And the chain's first entry has to be the
  // model the settings name, or the session records one model while another answers.
  const chainDrift =
    head !== undefined && (head.provider !== settings.defaultProvider || head.model !== settings.defaultModel);
  const unknown = [...new Set(chain.chain.map((e) => e.provider))].filter((id) => providers.table[id] === undefined);
  const chainOk = chain.error === null && providers.error === null && head !== undefined && !chainDrift && unknown.length === 0;
  checks.push({
    name: "模型回退",
    ok: chainOk,
    warnOnly: head === undefined && chain.error === null && providers.error === null,
    // A per-hop effort is set nowhere else the operator can read it back: without it two
    // chains that differ only in `reasoning_effort` print the same line.
    detail: chainOk
      ? `${chain.chain.length} 跳：${chain.chain
          .map((e) => {
            const effort = e.reasoningEffort === undefined ? "" : `（reasoningEffort=${e.reasoningEffort}）`;
            return `${e.provider}/${e.model}${effort}`;
          })
          .join(" → ")}`
      : [
          chain.error ?? "",
          providers.error ?? "",
          head === undefined ? `没有 ${p.modelChain}：模型报错就停下，没有回退` : "",
          chainDrift && head !== undefined
            ? `链的第一条是 ${head.provider}/${head.model}，settings 是 ${settings.defaultProvider}/${settings.defaultModel}——会话记的模型和真正回答的模型会对不上`
            : "",
          unknown.length > 0 ? `deploy/providers.json 里没有 ${unknown.join("、")}` : "",
        ]
          .filter((x) => x !== "")
          .join("；"),
  });

  // The session records the level settings names; an effort on the chain's first entry only
  // changes what is sent. The two disagree unless they happen to be the same level, and that
  // is the same shape as `chainDrift` above — likewise not a failure: the round still runs,
  // so this is a warning rather than something that blocks.
  const headEffort = head?.reasoningEffort;
  const recordedEffort = settings.defaultThinkingLevel;
  if (headEffort !== undefined && headEffort !== recordedEffort) {
    checks.push({
      name: "思考档位",
      ok: false,
      warnOnly: true,
      // Without a setting there is nothing to compare against: pi starts at `medium` and the
      // level goes into the transcript from there, so the same word on both sides can be the
      // same level or not — this line cannot tell, and must not claim it is a mismatch.
      detail:
        recordedEffort === undefined
          ? `链的第一条写了 reasoningEffort=${headEffort}，settings 里没有 defaultThinkingLevel（pi 启动时用 medium）——两边是不是同一个档，这里判断不了`
          : `链的第一条写了 reasoningEffort=${headEffort}，settings 的 defaultThinkingLevel 是 ${recordedEffort}——这一跳只改请求的档，会话记的档不跟着变；要两边一致，第一条就别写`,
    });
  }

  // Three states, because "not configured" and "configured but wrong" look identical from
  // the container: git just says the remote asked for a password.
  const gh = readGhApp(p);
  // Signing is the half of the exchange that can be checked without the network, and a
  // truncated or re-wrapped PEM is exactly how this breaks: the file exists, the doctor
  // says fine, and git says nothing at all for the rest of the day.
  let ghSigns = false;
  let ghWhy = "";
  if (gh.app !== null) {
    try {
      makeJwt(gh.app, Date.now());
      ghSigns = true;
    } catch (err) {
      ghWhy = (err as Error).message;
    }
  }
  checks.push({
    name: "GitHub App",
    ok: gh.app !== null && ghSigns,
    warnOnly: gh.app === null,
    detail:
      gh.app === null
        ? `没配（${gh.missing.join("、")}）：git push 会要求密码，别的都不受影响`
        : ghSigns
          ? `app ${gh.app.appId}，installation ${gh.app.installationId}`
          : `私钥签不动：${ghWhy}——git push 会要求密码`,
  });

  // Same file as the ids above, and the same shape of failure as an unsigned key: nothing
  // errors, the commit just lands with no author.
  const ident = gitIdentity(envVars, gh.app?.appId ?? "");
  checks.push({ name: "提交身份", ok: ident.ok, warnOnly: ident.missing, detail: ident.detail });

  checks.push({ name: "docker", ok: hasCmd("docker"), detail: "每一轮醒来是一个容器" });
  {
    const allowAllNames = policy.container.proxyAllow.includes("*");
    const chain = chainFrom(policy.container.proxyChain);
    checks.push({
      name: "出口代理",
      ok: policy.container.proxyAllow.length > 0 && policy.container.proxyAllowCidrs.length > 0,
      detail:
        policy.container.proxyAllow.length === 0 || policy.container.proxyAllowCidrs.length === 0
          ? "名单里有空的一项：容器没有任何出口（git、npm 都会失败）"
          : `${allowAllNames ? "放通所有名字" : `放行 ${policy.container.proxyAllow.join("、")}`}` +
            `，地址 ${policy.container.proxyAllowCidrs.length} 条` +
            `；daemon 自己${chain === null ? "直连" : `走 ${chain.kind} ${chain.host}:${chain.port}`}`,
      warnOnly: true,
    });
    // The five ranges an operator should never open by accident, each with its own reason.
    const dangerous: [string, string][] = [
      ["127.0.0.0/8", "容器能摸宿主上所有 loopback 服务"],
      ["169.254.0.0/16", "云元数据：那条路通向凭据"],
      ["172.17.0.0/16", "同机的其他容器"],
      ["10.0.0.0/8", "内网"],
      ["192.168.0.0/16", "内网"],
    ];
    const open = dangerous
      .filter(([cidr]) => rangeOpenUnder(cidr, policy.container.proxyAllowCidrs))
      .map(([cidr, why]) => `${cidr}（${why}）`);
    if (open.length > 0) {
      checks.push({
        name: "代理能进内网",
        ok: false,
        warnOnly: true,
        detail: open.join("；"),
      });
    }
  }

  const secretsMode = (() => {
    try {
      return statSync(p.secrets).mode & 0o777;
    } catch {
      return null;
    }
  })();
  checks.push({
    name: "secrets 权限",
    ok: secretsMode !== null && (secretsMode & 0o077) === 0,
    detail:
      secretsMode === null
        ? `缺少 ${p.secrets}`
        : `权限 ${secretsMode.toString(8)}（应为 600）`,
  });

  // 一个填错或漏填的值不会报错，只会让某件事安静地不发生。这几条是它唯一的出口。

  // 可选能力的三态：配好且对 = ok，配了但不对 = FAIL，没配 = warn。
  // 只有区分这三态，"漏配"才看得见——否则"没配"和"配好且安静"长得一样。
  const optional = (
    name: string,
    configured: boolean,
    problem: string | null,
    unset: string,
    fine: string,
  ): Check =>
    configured
      ? { name, ok: problem === null, detail: problem ?? fine }
      : { name, ok: false, warnOnly: true, detail: unset };

  const searchHost = readSearchEnv(root);
  // Three states, not two: no search.env is "not configured" and quiet; a search.env
  // whose socket is missing is a FAIL, because that is a service that was set up and is
  // not running — and the symptom otherwise is "the tool is missing", which reads as
  // "never configured".
  const socketMissing =
    searchHost !== null && !existsSync(searchHost.socket)
      ? `${searchHost.socket} 不存在：geng-search 服务没在跑`
      : null;
  // "Configured" is the operator having done anything at all. Whether it is *right* is
  // the problem string's job: half a wiring must not read as "never set up", because
  // that is the one state nobody goes looking for.
  checks.push(
    optional(
      "搜索接线",
      searchHost !== null,
      socketMissing,
      "没配：容器里没有 web_search",
      `socket 在 ${searchHost?.socket ?? "?"}，今天还剩 ${searchQuota(root)?.left ?? "?"} 次`,
    ),
  );

  const mailCfg = loadMailConfig(root);
  const mailEnv = readMailEnv(root);
  checks.push(
    optional(
      "邮件接线",
      mailCfg !== null || mailEnv !== null,
      mailWiringProblem(instance, mailCfg, mailEnv),
      "没配：信收不进来",
      "地址与 token 都在",
    ),
  );

  const bots = readBots(root);
  const issues = botIssues(bots, (key) => existsSync(join(root, "data", key)));
  // A broken bot belonging to bob is not a FAIL for alice. ops and file-wide problems
  // do reach every instance, so they stay in this check; the rest get their own warn
  // rather than silently disappearing from doctor's output.
  const { own, others } = botWiring(instance, issues);
  checks.push(
    optional(
      "bot 接线",
      bots[instance] !== undefined,
      own.length === 0 ? null : own.slice(0, 3).join("；"),
      `没配：只有它自己的闹钟能叫醒它${issues.length > 0 ? `（bots.json 另有 ${issues.length} 处问题）` : ""}`,
      "这个实例的 bot 能解析",
    ),
  );
  if (others.length > 0) {
    checks.push({
      name: "bots.json 其他条目",
      ok: false,
      warnOnly: true,
      detail: others.slice(0, 3).join("；"),
    });
  }
  // A channel owns its own checks, so adding one does not mean editing this file's
  // Telegram-specific block. `undefined` is "this channel has nothing extra to say".
  for (const channel of CHANNELS) {
    if (channel.doctor === undefined) continue;
    for (const check of channel.doctor(root, instance)) {
      checks.push({
        name: check.name,
        ok: check.ok,
        ...(check.warnOnly === undefined ? {} : { warnOnly: check.warnOnly }),
        detail: check.detail,
      });
    }
  }

  const sessions = listSessionFiles(p.sessionDir);
  const bad = sessions
    .map((f) => repairTail(f, fix))
    .filter((r) => r.repairedLines > 0 || r.note !== "ok");
  checks.push({
    name: "session 尾部",
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${sessions.length} 个文件完好` : bad.map((b) => `${b.file}: ${b.note}`).join("; "),
  });

  // A directory that was renamed once is a directory that will be missed silently: the
  // daemon simply starts writing into the new name, and the old sessions look like they
  // were never there. Only printed while the old one exists, so a migrated instance sees
  // nothing.
  const oldSessions = join(p.data, "session");
  if (existsSync(oldSessions)) {
    checks.push({
      name: "session 目录改名",
      ok: false,
      detail: `${oldSessions} 还在：v0.0.1 起叫 sessions/，停掉 daemon 后 mv 过去（跑着 mv 会让它建一个空目录）`,
    });
  }

  const waitingFresh = existsSync(p.waiting);
  checks.push({
    name: "waiting.json",
    ok: waitingFresh,
    detail: waitingFresh ? "在" : "不在——上次醒来没有留下下次什么时候见",
    warnOnly: true,
  });

  // An empty file and no file are the same thing to the agent: the mount is created
  // empty so docker has something to bind, so "在" has to mean "has something in it".
  const identity = (readText(p.identity) ?? "").trim() !== "";
  checks.push({
    name: "identity.md",
    ok: identity,
    detail: identity ? "在" : "还没写过（第一次出生之后才有意义）",
    warnOnly: true,
  });

  // An id is a permanent name: delete the newest entry and the next write must not reuse
  // it. The files can only raise the ceiling (a restored snapshot has ids the counter has
  // never seen), never lower it, so losing this file is what lets an old name be handed
  // out twice — and nothing else would notice.
  const ids = readJson<{ journalN?: number; loopN?: number } | null>(p.ids, null);
  const written = (existsSync(p.journal) ? readdirSafe(p.journal) : 0) + (existsSync(p.openLoops) ? readdirSafe(p.openLoops) : 0);
  checks.push({
    name: "meta/ids.json",
    ok: ids !== null || written === 0,
    detail: ids !== null ? "在" : "不在——书里已有东西却不知道发到几号了，下一个 id 可能和旧的重名",
    warnOnly: true,
  });

  const schema = onDiskSchema(p);
  const conflict = schemaConflict(schema);
  checks.push({
    name: "stateSchema",
    ok: conflict === null,
    warnOnly: schema !== null && schema < STATE_SCHEMA,
    detail:
      conflict ??
      (schema === null
        ? "还没有这个生命（第一次醒来时会写上）"
        : schema < STATE_SCHEMA
          ? `${schema} < ${STATE_SCHEMA}：旧版本写的，下一轮醒来会补上；真改过形状才需要迁移`
          : `${schema}`),
  });

  checks.push({
    name: "open-loops 是目录",
    ok: !existsSync(`${p.openLoops}.json`),
    detail: existsSync(`${p.openLoops}.json`)
      ? "旧的 open-loops.json 还在：现在是一件一个文件的目录，旧文件不会被读"
      : "是",
    warnOnly: true,
  });

  // A directory here is not a cosmetic problem: every line the daemon appends fails with
  // EISDIR, so "the log stopped" is the only symptom. A stray mkdir or a restore that landed
  // on the wrong path is how it happens — nothing mounts this file.
  const logIsFile = (() => {
    try {
      return statSync(p.daemonLog).isFile();
    } catch {
      return null;
    }
  })();
  checks.push({
    name: "daemon.log 是文件",
    ok: logIsFile !== false,
    detail:
      logIsFile === false
        ? "它是个目录：删掉，再跑一次 init 就会建成文件"
        : logIsFile === null
          ? "还没有"
          : "是",
    warnOnly: logIsFile === null,
  });

  const logAge = (() => {
    try {
      return Date.now() - statSync(p.daemonLog).mtimeMs;
    } catch {
      return null;
    }
  })();
  checks.push({
    name: "daemon.log 新鲜度",
    ok: logAge !== null && logAge < 24 * 3600_000,
    detail: logAge === null ? "没有日志" : `最后一行 ${Math.round(logAge / 60000)} 分钟前`,
    warnOnly: true,
  });

  // data/ must never be tracked, but must never be missing either
  try {
    const tracked = execFileSync("git", ["-C", root, "ls-files", "data"], { encoding: "utf8" }).trim();
    checks.push({ name: "data 未被 git 跟踪", ok: tracked === "", detail: tracked === "" ? "干净" : tracked.split("\n").length + " 个文件被跟踪" });
  } catch {
    checks.push({ name: "data 未被 git 跟踪", ok: true, detail: "不是 git 仓库，跳过", warnOnly: true });
  }

  // Two checks, because a key is not always a file: one pasted into a log stays a *line*.
  const keyish = keyFiles(p.data).join(", ");
  checks.push({
    name: "data 里没有 key 文件",
    ok: keyish === "",
    detail: keyish === "" ? "干净" : keyish,
  });

  const scan = scanLogBodies(p.data);
  const leaked = scan.hits.join(", ");
  checks.push({
    name: "日志里没有 key 形状",
    ok: leaked === "",
    // 只警告不 FAIL：老日志里的旧 token 删不掉也轮换不回去，一个永远红的检查会被当成背景噪音。
    warnOnly: true,
    detail:
      leaked !== ""
        ? `${leaked}${scan.more > 0 ? `（另有 ${scan.more} 处没列出）` : ""} —— 先换掉那个 token；删日志不会让它变回没泄过`
        : scan.truncated.length > 0
          // 「干净」不带这个后缀就是一句假话：再往前的字节没人看过
          ? `干净（${scan.truncated.join("、")} 超过 8 MiB，只看了最后 8 MiB）`
          : "干净",
  });

  return checks;
}

/** Directories that never hold config of ours and are huge: walking them only costs time. */
const SKIP_DIRS = new Set(["seen", "node_modules", ".git"]);

// The agent's scratch, skipped wholesale by both scans below. A killed round leaves whatever
// it was writing here — often a complete data tree with `secrets/*.env` fixtures — and a scan
// that reports that on every run teaches people to ignore the warning. The rest of the
// workspace is still scanned: a token written out as a file there is a real leak. `backup.ts`
// excludes the same path as a glob, so if the scratch moves, both move.
const SCRATCH_DIR = join("workspace", "tmp");

/** Key-shaped *file names* under data/. A token pasted into a log has another shape: see scanLogBodies. */
export function keyFiles(dir: string): string[] {
  const scratch = join(dir, SCRATCH_DIR);
  const hits: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && full !== scratch) walk(full);
      } else if (/\.(env|pem|key)$/.test(e.name)) {
        hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

/** A token in a log is worth finding: this is where a retry prints the URL that failed.
 *
 * 这七条是从 `tools/gate/patterns.mjs` 的凭据表里选出来的（那份表是每次合并前跑的门）。
 * 没搬过来的那些是赋值形状（`TOKEN=…`、`Bearer …`、连接串）：日志里天天有，一条见谁都报的
 * 检查最后就没人看了。那边加了凭据形状，这里也该加。
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  // 无状态安装令牌是 `ghs_<app id>_<jwt>`，前缀后第一段就有下划线和点：
  // 只认字母数字的正则会把它整条漏掉。
  [/\bgh[pousr]_[A-Za-z0-9._-]{36,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "sk- 形状的 key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "Telegram bot token"],
];

/** daemon.log rotates at 20 000 lines but is still the biggest thing here: read the tail. */
const LOG_TAIL_LIMIT = 8 * 1024 * 1024;

function tailText(file: string): { text: string; truncated: boolean } | null {
  try {
    const size = statSync(file).size;
    if (size <= LOG_TAIL_LIMIT) return { text: readFileSync(file, "utf8"), truncated: false };
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(LOG_TAIL_LIMIT);
      const read = readSync(fd, buf, 0, LOG_TAIL_LIMIT, size - LOG_TAIL_LIMIT);
      return { text: buf.subarray(0, read).toString("utf8"), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** What the scan found, and what it could not see: a lenient reader must not call that clean. */
export interface LogScan {
  hits: string[];
  /** Logs bigger than the tail limit, by name: only their last 8 MiB was read. */
  truncated: string[];
  /** Hits the cap kept out of `hits`. */
  more: number;
}

export function scanLogBodies(dir: string): LogScan {
  const scratch = join(dir, SCRATCH_DIR);
  const hits: string[] = [];
  const truncated: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && full !== scratch) walk(full);
        continue;
      }
      // `appendLine` rotates to `<file>.1`, and a name that stops ending in `.log` would
      // fall out of the scan exactly when the file it was protecting got older
      if (!e.name.endsWith(".log") && !/\.log\.\d+$/.test(e.name)) continue;
      const tail = tailText(full);
      if (tail === null) continue;
      if (tail.truncated) truncated.push(e.name);
      for (const [re, label] of SECRET_SHAPES) {
        const n = tail.text.match(new RegExp(re, "g"))?.length ?? 0;
        if (n > 0) hits.push(`${full}: ${label}${n > 1 ? ` ×${n}` : ""}`);
      }
    }
  };
  walk(dir);
  // the detail is one line in a doctor table: ten is already more than anyone reads
  return { hits: hits.slice(0, 10), truncated, more: Math.max(0, hits.length - 10) };
}

/** One string over every tool in a directory, from `cksum` output: the file names and
 *  their bytes. Counting files is not enough — the tools used to be baked into the image,
 *  so "same count, different bytes" (a stale mount, a half-synced checkout) was invisible.
 *  Run on both sides so the two strings are comparable byte for byte. */
export function toolsDigest(dir: string): string {
  const script =
    `[ -d "${dir}" ] || exit 0; ls "${dir}"/*.ts >/dev/null 2>&1 || exit 0; ` +
    `(cd "${dir}" && LC_ALL=C cksum ./*.ts) | sha1sum | cut -c1-40`;
  try {
    return execFileSync("sh", ["-c", script], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export const PROBE = [
  "sh",
  "-c",
  [
    // the entrypoint starts these; the probe bypasses it, so it has to do the same or it
    // measures a container with no way out at all
    // a subshell, because these are joined with `; ` and `&;` is a syntax error
    '(socat TCP-LISTEN:11434,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/geng/book.sock >/dev/null 2>&1 &)',
    '(socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/geng/book.sock >/dev/null 2>&1 &)',
    'sleep 0.3',
    'if [ -e /state/policy.json ]; then echo POLICY_VISIBLE; else echo POLICY_HIDDEN; fi',
    // the tools are a mount now: pi is started with one -e per file, and a file that is
    // listed and then missing makes it exit 1, so that shape dies loudly. But if the
    // directory itself is gone, extensionArgs yields no -e at all, and the wake comes up
    // with no tools and says nothing — the digest check below is the only net for that one
    'echo "EXT_COUNT=$(ls /opt/geng/extensions/*.ts 2>/dev/null | wc -l) EXT_DIGEST=$( (cd /opt/geng/extensions && LC_ALL=C cksum ./*.ts) 2>/dev/null | sha1sum | cut -c1-40)"',
    // Two sides, because one alone proves nothing: direct egress has to be *broken* and
    // the proxy has to work. A container that can still reach github directly would pass
    // "proxy works" while the thing this is supposed to prevent is happening.
    'if curl -s -m 5 --noproxy "*" -o /dev/null https://github.com/ 2>/dev/null; then echo NET_DIRECT_OK; else echo NET_DIRECT_BLOCKED; fi',
    'if curl -s -m 20 -o /dev/null https://github.com/ 2>/dev/null; then echo PROXY_OK; else echo PROXY_DEAD; fi',
    // Its own route, not the proxy: through the proxy this measures our refusal, and a 403
    // from the proxy was being read as "the metadata answered". `%{http_code}` prints 000
    // when no connection was made, which is what "no route" actually looks like.
    'printf "META_CODE=%s\\n" "$(no_proxy=* curl -s -m 3 -o /dev/null -w \"%{http_code}\" http://169.254.169.254/ 2>/dev/null)"',
    // the real attack path is the host on our own gateway, not a fixed docker0 address
    // `\\$3`, not `$3` once: the JS string has to hand the shell a literal `\$3`, or the
    // shell expands `$3` (empty) inside the double quotes and awk prints the whole line.
    'GW=$(ip route 2>/dev/null | awk "/^default/{print \\$3; exit}"); if [ -n "$GW" ] && curl -s -m 3 -o /dev/null "http://$GW:2375/version" 2>/dev/null; then echo DOCKER_REACHABLE; else echo DOCKER_BLOCKED; fi',
    "true",
  ].join("; "),
];

/**
 * The status code the probe got from the metadata address over its own route, or null when
 * the probe did not report one.
 *
 * A status is not a success story: `000` is curl's "no connection was made", and every
 * other code means something answered — which, for an address that must not be routable at
 * all, is the finding. Reading curl's exit status instead conflated the two: a refusal
 * from our own proxy exits 0 and looked exactly like a host that answered.
 */
export function metaCode(probeOut: string): string | null {
  const m = /META_CODE=(\d{3})/.exec(probeOut);
  return m === null ? null : (m[1] as string);
}

/** Which problems belong to this instance: its own key, plus what is file-wide ("*")
 *  or shared by every instance ("ops"). The rest belong to somebody else. */
export function botWiring(instance: string, issues: BotIssue[]): { own: string[]; others: string[] } {
  const own = issues
    .filter((i) => i.key === instance || i.key === "ops" || i.key === "*")
    .map((i) => i.problem);
  const others = issues
    .filter((i) => i.key !== instance && i.key !== "ops" && i.key !== "*")
    .map((i) => i.problem);
  return { own, others };
}

/** Whether anything is listening on the book socket right now. */
function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 300);
  });
}

/** What the container can actually do — the only honest way to test mounts and egress. */
async function probe(root: string, instance: string): Promise<Check[]> {
  const o = makePaths(root, instance);
  const policy = loadPolicy(o.policy);
  const checks: Check[] = [];

  if (!hasCmd("docker")) {
    checks.push({ name: "容器探针", ok: false, detail: "没有 docker" });
    return checks;
  }

  const command = buildCommand(o, policy, "geng-doctor-probe", "probe", PROBE);
  const onHost = existsSync(o.extensions)
    ? readdirSync(o.extensions).filter((f) => f.endsWith(".ts")).length
    : 0;
  const digestOnHost = onHost > 0 ? toolsDigest(o.extensions) : "";
  const out = await new Promise<string>((resolve) => {
    const p = spawn(command.cmd, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (t: string): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(t);
    };
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (c: string) => {
      text += c;
    });
    p.stderr?.setEncoding("utf8");
    p.stderr?.on("data", (c: string) => {
      text += c;
    });
    p.on("error", () => finish(`PROBE_FAILED ${String(p.spawnfile)}`));
    p.on("close", () => finish(text));
    // A wedged `docker run` must read as "the probe did not finish", never as silence that
    // the checks below then treat as a passed proxy test.
    timer = setTimeout(() => {
      p.kill();
      finish(`${text}\nPROBE_FAILED docker run 超时（90s），探针没有跑完`);
    }, 90_000);
  });
  const inContainer = Number(/EXT_COUNT=(\d+)/.exec(out)?.[1] ?? -1);
  const digestInContainer = /EXT_DIGEST=([0-9a-f]{40})/.exec(out)?.[1] ?? "";

  // Without a running daemon there is no proxy to test: the socket exists but nothing
  // answers, which is indistinguishable from a broken proxy unless it is said out loud.
  const daemonUp = await socketAlive(socketPath(o));
  checks.push({
    name: "只有代理能出去",
    ok: out.includes("PROXY_OK") && out.includes("NET_DIRECT_BLOCKED"),
    warnOnly: !daemonUp,
    detail: out.includes("NET_DIRECT_OK")
      ? "容器能直连 github.com —— --network none 没生效，代理只是装饰"
      : !daemonUp
        ? "daemon 没在跑，代理无从验证（先起 daemon 再跑 --probe）"
        : out.includes("PROXY_DEAD")
          ? "代理不通：容器拿不到任何出口（socat 没起来，或 socket 不在）"
          : "直连断开，代理通",
  });
  checks.push({
    name: "policy.json 不可见",
    ok: out.includes("POLICY_HIDDEN"),
    detail: out.includes("POLICY_VISIBLE") ? "容器里能看到 policy.json —— 它不该在自己的书里读规则" : "看不见",
  });
  // Two empty strings are equal, and "both sides returned nothing" is not evidence that the
  // two sides agree: `toolsDigest` gives "" when its own shell cannot run (a minimal PATH is
  // enough for that), and the probe gives "" when the container never printed its line. Both
  // empty has to read as "compared nothing", never as "the same".
  const comparable = digestOnHost !== "" && digestInContainer !== "";
  const mounted = onHost > 0 && comparable && digestInContainer === digestOnHost;
  const detail = mounted
    ? `${onHost} 个，内容与宿主一致（${digestOnHost.slice(0, 8)}）`
    : inContainer < 0
      ? "探针没数出来 —— 容器里读不到 /opt/geng/extensions"
      : onHost === 0
        ? `宿主 image/extensions 里没有 .ts，容器里 ${inContainer} 个 —— 检查无从比起`
        : !comparable
          ? `宿主 ${onHost} 个，容器里 ${inContainer} 个，但摘要没算出来（${digestOnHost === "" ? "宿主" : "容器"}那一侧是空的）—— 内容比不了`
          : inContainer === 0
            ? `容器里 /opt/geng/extensions 是空的，宿主 ${onHost} 个 —— 挂载缺了；pi 收到不存在的 -e 会 exit(1)，agent 起不来`
            : inContainer === onHost
              ? `${onHost} 个，个数相同但内容不同（${digestOnHost.slice(0, 8)} → ${digestInContainer.slice(0, 8)}）—— 旧挂载或半同步的 checkout`
              : `宿主 image/extensions 里 ${onHost} 个（${digestOnHost.slice(0, 8)}），容器里 ${inContainer} 个（${digestInContainer.slice(0, 8)}）`;
  checks.push({ name: "工具挂载", ok: mounted, detail });
  const meta = metaCode(out);
  checks.push({
    name: "云元数据不可达",
    ok: meta === "000",
    detail:
      meta === null
        ? "探针没报 META_CODE —— 那一段脚本没跑到"
        : meta === "000"
          ? "不可达"
          : `169.254.169.254 可达（HTTP ${meta}）—— 凭证可能泄露`,
  });
  checks.push({
    name: "宿主 docker 不可达",
    ok: out.includes("DOCKER_BLOCKED"),
    detail: out.includes("DOCKER_REACHABLE") ? "容器能摸到宿主 docker" : "不可达",
  });
  if (out.includes("PROBE_FAILED")) {
    checks.push({ name: "容器探针", ok: false, detail: out.trim().slice(0, 300) });
  }
  return checks;
}

export function runDoctor(root: string, instance: string, fix: boolean, extra: Check[] = []): number {
  const checks = [...checkInstance(root, instance, fix), ...extra];
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.warnOnly ? "warn" : "FAIL";
    if (!c.ok && !c.warnOnly) failed++;
    console.log(`${mark}  ${c.name.padEnd(20)} ${c.detail}`);
  }
  return failed === 0 ? 0 : 1;
}

export interface DoctorOptions {
  root: string;
  instance: string;
  fix: boolean;
  probe: boolean;
  restoreTest: boolean;
}

export async function runDoctorWithProbe(o: DoctorOptions): Promise<number> {
  const extra: Check[] = o.probe ? await probe(o.root, o.instance) : [];
  extra.push(...(await backupChecks(o.root, o.instance, o.restoreTest)));
  return runDoctor(o.root, o.instance, o.fix, extra);
}

async function backupChecks(root: string, instance: string, restoreTest: boolean): Promise<Check[]> {
  const p = makePaths(root, instance);
  const checks: Check[] = [];
  let policy: Policy;
  try {
    policy = loadPolicy(p.policy);
  } catch {
    return checks;
  }
  if (!policy.backup.enabled) {
    checks.push({ name: "备份", ok: false, warnOnly: true, detail: "policy 里关掉了" });
    return checks;
  }
  if (!(await rusticAvailable())) {
    checks.push({ name: "备份", ok: false, warnOnly: true, detail: "没有 rustic，每轮自动跳过" });
    return checks;
  }

  const list = await listSnapshots(p);
  if (!list.ok) {
    checks.push({ name: "备份", ok: false, warnOnly: true, detail: `读不出快照：${list.detail ?? "?"}` });
    return checks;
  }
  if (list.snapshots.length === 0) {
    checks.push({ name: "备份", ok: false, warnOnly: true, detail: "还没有快照" });
    return checks;
  }
  const snapshots = list.snapshots;
  const latest = snapshots[snapshots.length - 1];
  const ageMs = Date.now() - Date.parse(latest?.time ?? "");
  checks.push({
    name: "备份",
    ok: ageMs < 24 * 60 * 60 * 1000,
    warnOnly: true,
    detail: `${snapshots.length} 张，最近一张 ${formatDuration(ageMs)} 前（${latest?.id.slice(0, 8)}，${latest?.files} 个文件）`,
  });

  const deploy = readJson<{ daemonVersion?: string }>(join(p.meta, "deploy.json"), {});
  const pkg = readJson<{ version?: string }>(join(root, "package.json"), {});
  if (deploy.daemonVersion && pkg.version && deploy.daemonVersion !== pkg.version) {
    checks.push({
      name: "备份与当前版本",
      ok: false,
      warnOnly: true,
      detail: `快照由 ${deploy.daemonVersion} 写下，现在是 ${pkg.version}`,
    });
  }

  if (restoreTest) {
    const target = mkdtempSync(join(tmpdir(), "geng-restore-"));
    const result = await restore({ paths: p, target });
    const whole = result.ok ? restoredLooksWhole(target) : { ok: false, missing: [result.detail] };
    rmSync(target, { recursive: true, force: true });
    checks.push({
      name: "恢复演练",
      ok: whole.ok,
      detail: whole.ok ? "最近一张能读回来" : `缺 ${whole.missing.join("、")}`,
    });
  }
  return checks;
}
