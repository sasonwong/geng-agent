import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { listSessionFiles } from "./runner.ts";
import { makePaths } from "./paths.ts";
import { loadPolicy } from "./policy.ts";
import { repairTail } from "./session.ts";

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

  let policy;
  try {
    policy = loadPolicy(p.policy);
    checks.push({ name: "policy 解析", ok: true, detail: `runner=${policy.runner}` });
  } catch (err) {
    checks.push({ name: "policy 解析", ok: false, detail: (err as Error).message });
    return checks;
  }

  if (policy.runner === "docker") {
    checks.push({ name: "docker", ok: hasCmd("docker"), detail: "run 需要 docker 可执行" });
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
    name: "secrets",
    ok: secretsMode !== null && (secretsMode & 0o077) === 0,
    detail:
      secretsMode === null
        ? `缺少 ${p.secrets}`
        : `权限 ${secretsMode.toString(8)}（应为 600）`,
  });

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

export function runDoctor(root: string, instance: string, fix: boolean): number {
  const checks = checkInstance(root, instance, fix);
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.warnOnly ? "warn" : "FAIL";
    if (!c.ok && !c.warnOnly) failed++;
    console.log(`${mark}  ${c.name.padEnd(20)} ${c.detail}`);
  }
  return failed === 0 ? 0 : 1;
}
