import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { listSnapshots, restore, restoredLooksWhole, rusticAvailable } from "./backup.ts";
import { formatDuration } from "./schedule.ts";
import { readJson } from "./state.ts";
import { readBots, botProblems } from "./bots.ts";
import { loadMailConfig, readMailEnv } from "./mail.ts";
import { envProblem, mailWiringProblem, searchPairProblem, readEnvFile } from "./secret.ts";
import { searchConfigured, searchQuota } from "./search.ts";
import { buildCommand, listSessionFiles } from "./command.ts";
import { makePaths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { repairTail } from "./session.ts";
import { onDiskSchema, schemaConflict, STATE_SCHEMA } from "./schema.ts";

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
    checks.push({ name: "policy 解析", ok: true, detail: `runner=${policy.runner}` });
  } catch (err) {
    checks.push({ name: "policy 解析", ok: false, detail: (err as Error).message });
    return checks;
  }

  const settings = readJson<{ defaultProvider?: string; defaultModel?: string }>(
    join(p.piDir, "settings.json"),
    {},
  );
  checks.push({
    name: "容器 settings",
    ok: typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string",
    detail:
      typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
        ? `${settings.defaultProvider}/${settings.defaultModel}`
        : `${join(p.piDir, "settings.json")} 里没有 defaultProvider/defaultModel：容器连不上模型`,
    warnOnly: policy.runner !== "docker",
  });

  if (policy.runner === "docker") {
    checks.push({ name: "docker", ok: hasCmd("docker"), detail: "run 需要 docker 可执行" });
    checks.push({
      name: "出口网络",
      ok: policy.container.network !== null,
      detail:
        policy.container.network === null
          ? "container.network 是 null，容器会落在默认桥接上，egress.sh 无从生效"
          : policy.container.network,
      warnOnly: true,
    });
  } else {
    checks.push({ name: "pi 可执行", ok: hasCmd("pi"), detail: "local runner 直接调用 pi" });
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
  const instEnv = readEnvFile(p.secrets);
  const missingKey = envProblem(instEnv);
  checks.push({
    name: "模型凭据",
    ok: missingKey === null,
    detail: missingKey ?? "有 *_API_KEY",
  });

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

  const searchOn = searchConfigured(p.secrets);
  const pair = searchPairProblem(instEnv, readEnvFile(join(root, "secrets", "search.env")));
  checks.push(
    optional(
      "搜索接线",
      searchOn,
      pair,
      "没配：容器里没有 web_search",
      `两处 token 一致，今天还剩 ${searchQuota(root, p.secrets)?.left ?? "?"} 次`,
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
  const issues = botProblems(bots, (key) => existsSync(join(root, "data", key)));
  checks.push(
    optional(
      "bot 接线",
      bots[instance] !== undefined,
      issues.length === 0 ? null : issues.slice(0, 3).join("；"),
      `没配：只有它自己的闹钟能叫醒它${issues.length > 0 ? `（bots.json 另有 ${issues.length} 处问题）` : ""}`,
      "bots.json 的每一项都能解析",
    ),
  );

  const sessions = listSessionFiles(p.sessionDir);
  const bad = sessions
    .map((f) => repairTail(f, fix))
    .filter((r) => r.repairedLines > 0 || r.note !== "ok");
  checks.push({
    name: "session 尾部",
    ok: bad.length === 0,
    detail: bad.length === 0 ? `${sessions.length} 个文件完好` : bad.map((b) => `${b.file}: ${b.note}`).join("; "),
  });

  const waitingFresh = existsSync(p.waiting);
  checks.push({
    name: "waiting.json",
    ok: waitingFresh,
    detail: waitingFresh ? "在" : "不在——上次醒来没有留下下次什么时候见",
    warnOnly: true,
  });

  const identity = existsSync(p.identity);
  checks.push({
    name: "identity.md",
    ok: identity,
    detail: identity ? "在" : "还没写过（第一次出生之后才有意义）",
    warnOnly: true,
  });

  // A directory here is not a cosmetic problem: docker materialises a missing bind-mount
  // target as a directory, and then every line the daemon appends fails with EISDIR.
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
        ? "它是个目录：容器挂载时自动创建的，删掉再跑一次 init"
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

  const keyish = scanForSecrets(p.data);
  checks.push({
    name: "data 里没有 key",
    ok: keyish === "",
    detail: keyish === "" ? "干净" : keyish,
  });

  return checks;
}

function scanForSecrets(dir: string): string {
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
        if (e.name === "seen") continue;
        walk(full);
      } else if (/\.(env|pem|key)$/.test(e.name)) {
        hits.push(full);
      }
    }
  };
  walk(dir);
  return hits.join(", ");
}

const PROBE = [
  "sh",
  "-c",
  [
    'if [ -e /state/policy.json ]; then echo POLICY_VISIBLE; else echo POLICY_HIDDEN; fi',
    'ls /state >/dev/null 2>&1 && echo STATE_OK || echo STATE_MISSING',
    // the positive control: without it, "everything blocked" passes every check below
    'if curl -s -m 8 -o /dev/null https://opencode.ai/ 2>/dev/null; then echo EGRESS_OK; else echo EGRESS_DEAD; fi',
    'if curl -s -m 3 -o /dev/null http://169.254.169.254/ 2>/dev/null; then echo META_REACHABLE; else echo META_BLOCKED; fi',
    // the real attack path is the host on our own gateway, not a fixed docker0 address
    'GW=$(ip route 2>/dev/null | awk "/^default/{print \$3; exit}"); if [ -n "$GW" ] && curl -s -m 3 -o /dev/null "http://$GW:2375/version" 2>/dev/null; then echo DOCKER_REACHABLE; else echo DOCKER_BLOCKED; fi',
    "true",
  ].join("; "),
];

/** What the container can actually do — the only honest way to test mounts and egress. */
async function probe(root: string, instance: string): Promise<Check[]> {
  const o = makePaths(root, instance);
  const policy = loadPolicy(o.policy);
  const checks: Check[] = [];

  if (policy.runner !== "docker") {
    checks.push({ name: "容器探针", ok: false, detail: "runner 不是 docker，跳过", warnOnly: true });
    return checks;
  }
  if (!hasCmd("docker")) {
    checks.push({ name: "容器探针", ok: false, detail: "没有 docker" });
    return checks;
  }

  const command = buildCommand(o, policy, "geng-doctor-probe", "probe", [], PROBE);
  const out = await new Promise<string>((resolve) => {
    const p = spawn(command.cmd, command.args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout?.setEncoding("utf8");
    p.stdout?.on("data", (c: string) => {
      text += c;
    });
    p.stderr?.setEncoding("utf8");
    p.stderr?.on("data", (c: string) => {
      text += c;
    });
    p.on("error", () => resolve(`PROBE_FAILED ${String(p.spawnfile)}`));
    p.on("close", () => resolve(text));
  });

  checks.push({
    name: "容器能上网",
    ok: out.includes("EGRESS_OK"),
    detail: out.includes("EGRESS_DEAD")
      ? "容器连不上 opencode.ai —— 出口规则把 80/443 也拦了"
      : "通",
  });
  checks.push({
    name: "policy.json 不可见",
    ok: out.includes("POLICY_HIDDEN"),
    detail: out.includes("POLICY_VISIBLE") ? "容器里能看到 policy.json —— 它不该在自己的书里读规则" : "看不见",
  });
  checks.push({
    name: "云元数据不可达",
    ok: out.includes("META_BLOCKED"),
    detail: out.includes("META_REACHABLE") ? "169.254.169.254 可达 —— 凭证可能泄露" : "不可达",
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

export function runDoctor(
  root: string,
  instance: string,
  fix: boolean,
  withProbe: boolean,
  extra: Check[] = [],
): number {
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
  return runDoctor(o.root, o.instance, o.fix, o.probe, extra);
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

  const snapshots = await listSnapshots(p);
  if (snapshots.length === 0) {
    checks.push({ name: "备份", ok: false, warnOnly: true, detail: "还没有快照" });
    return checks;
  }
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
