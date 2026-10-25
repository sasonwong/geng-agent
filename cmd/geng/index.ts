#!/usr/bin/env node
import { join, resolve } from "node:path";
import { runDaemon } from "../../internal/daemon.ts";
import { ExpectedError } from "../../internal/errors.ts";
import { runDoctorWithProbe } from "../../internal/doctor.ts";
import { initInstance } from "../../internal/init.ts";
import { makePaths } from "../../internal/paths.ts";
import { listInstances, printStatus, statusLine } from "../../internal/status.ts";
import { runGateway } from "../../internal/gateway.ts";
import { readSearchEnv, startSearchServer } from "../../internal/search.ts";
import { backupRepo, listSnapshots, maybeBackup, restore, restoredLooksWhole } from "../../internal/backup.ts";
import { loadPolicy } from "../../internal/policy.ts";
import { clearMutes } from "../../internal/mute.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `geng <command> [options]

  init <instance>                    建目录、落 policy、生成 secrets 模板
  daemon --instance <instance>       一直跑（调试用 geng-dev，见 AGENTS.md）
  status [<instance>|--all]          一屏看状态
  doctor <instance> [--fix] [--probe] [--restore-test]
                                     把不变量变成检查（--probe 起个容器真验挂载与出口，
                                     --restore-test 把最近一张快照恢复到临时目录再读回来）
  backup <instance> [--list]         立刻拍一张快照 / 列已有快照
  unmute <instance> [--target <t>]   清掉静音（默认全清；--target dm / chat:<id> / *）
  restore <instance> [<id>] --yes    恢复到 backup/<instance>.restore-<时间>/（默认最近一张；
                                     没有 --yes 不动手；不直接覆盖 data/，自己拷回去）
  gateway                            跑消息搬运（需要 secrets/bots.json）
  search                             跑搜索端点（需要 secrets/search.env）

通用选项：
  --root <path>                      仓库根目录（默认：本仓库）
`;

interface Args {
  cmd: string;
  instance: string | null;
  root: string;
  fix: boolean;
  probe: boolean;
  restoreTest: boolean;
  list: boolean;
  yes: boolean;
  all: boolean;
  target: string | null;
  rest: string[];
}

function parse(argv: string[]): Args {
  const args: Args = {
    cmd: argv[0] ?? "",
    instance: null,
    root: REPO_ROOT,
    fix: false,
    probe: false,
    restoreTest: false,
    list: false,
    yes: false,
    all: false,
    target: null,
    rest: [],
  };
  const rest = argv.slice(1);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--root") {
      const v = rest[++i];
      if (!v) throw new Error("--root 需要一个路径");
      args.root = resolve(v);
    } else if (a === "--instance") {
      const v = rest[++i];
      if (!v) throw new Error("--instance 需要一个名字");
      args.instance = v;
    } else if (a === "--fix") {
      args.fix = true;
    } else if (a === "--probe") {
      args.probe = true;
    } else if (a === "--restore-test") {
      args.restoreTest = true;
    } else if (a === "--list") {
      args.list = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--target") {
      const v = rest[++i];
      if (!v) throw new Error("--target 需要一个值");
      args.target = v;
    } else if (a === "--all") {
      args.all = true;
    } else if (a === "-h" || a === "--help") {
      args.cmd = "help";
    } else if (a.startsWith("-")) {
      throw new Error(`未知选项 ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (args.instance === null && positional.length > 0) args.instance = positional[0] as string;
  args.rest = positional;
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    return 2;
  }

  switch (args.cmd) {
    case "help":
    case "":
      console.log(USAGE);
      return 0;

    case "init": {
      if (!args.instance) {
        console.error("用法：geng init <instance>");
        return 2;
      }
      initInstance(args.root, args.instance);
      const p = makePaths(args.root, args.instance);
      console.log(`已初始化 ${p.instance}`);
      console.log(`  数据     ${p.data}`);
      console.log(`  密钥     ${p.secrets}（填好之后再跑）`);
      console.log("");
      console.log("该空的地方都空着：identity / open-loops / waiting 都没有。");
      console.log("下一步：");
      console.log(`  geng doctor ${p.instance}`);
      console.log(`  geng daemon --instance ${p.instance}`);
      return 0;
    }

    case "daemon": {
      if (!args.instance) {
        console.error("用法：geng daemon --instance <instance>");
        return 2;
      }
      await runDaemon({
        root: args.root,
        instance: args.instance,
      });
      return 0;
    }

    case "status": {
      if (args.all) {
        for (const i of listInstances(args.root)) console.log(statusLine(args.root, i));
        return 0;
      }
      if (!args.instance) {
        const all = listInstances(args.root);
        if (all.length === 0) {
          console.log("还没有实例。先跑 geng init <name>");
          return 0;
        }
        for (const i of all) console.log(statusLine(args.root, i));
        return 0;
      }
      await printStatus(args.root, args.instance);
      return 0;
    }

    case "doctor": {
      if (!args.instance) {
        console.error("用法：geng doctor <instance> [--fix]");
        return 2;
      }
      return await runDoctorWithProbe({
        root: args.root,
        instance: args.instance,
        fix: args.fix,
        probe: args.probe,
        restoreTest: args.restoreTest,
      });
    }

    case "backup": {
      if (!args.instance) {
        console.error("用法：geng backup <instance> [--list]");
        return 2;
      }
      const p = makePaths(args.root, args.instance);
      if (args.list) {
        const snapshots = await listSnapshots(p);
        const policy = loadPolicy(p.policy);
        if (snapshots.length === 0) {
          console.log(`没有快照（仓库 ${backupRepo(p)}，备份${policy.backup.enabled ? "开着" : "关着"}）`);
          return 0;
        }
        for (const s of snapshots.slice(-20)) {
          console.log(`${s.id.slice(0, 8)}  ${s.time}  ${s.files} 个文件`);
        }
        console.log(`${snapshots.length} 张`);
        return 0;
      }
      const outcome = await maybeBackup({ paths: p, policy: loadPolicy(p.policy), nowMs: Date.now() });
      console.log(`${outcome.status}${outcome.detail ? ` ${outcome.detail}` : ""}${outcome.ms ? ` · ${outcome.ms}ms` : ""}`);
      return outcome.status === "fail" ? 1 : 0;
    }

    case "restore": {
      if (!args.instance) {
        console.error("用法：geng restore <instance> [<snapshot-id>] --yes");
        return 2;
      }
      const p = makePaths(args.root, args.instance);
      if (!args.yes) {
        console.error("恢复会把快照解到 backup/ 下的一份新目录里。确认的话加 --yes。");
        return 2;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = join(args.root, "backup", `${args.instance}.restore-${stamp}`);
      const result = await restore({ paths: p, snapshot: args.rest[1], target });
      if (!result.ok) {
        console.error(`失败：${result.detail}`);
        return 1;
      }
      const whole = restoredLooksWhole(target);
      console.log(`恢复到 ${target}`);
      console.log(whole.ok ? "内容完整。" : `缺 ${whole.missing.join("、")}`);
      console.log("确认没问题后，停掉 daemon，把里面的 data/<instance>/ 拷回去。");
      return whole.ok ? 0 : 1;
    }

    case "unmute": {
      if (!args.instance) {
        console.error("用法：geng unmute <instance> [--target dm|'chat:<id>'|'*']");
        return 2;
      }
      const p = makePaths(args.root, args.instance);
      const cleared = clearMutes(join(p.palimpsest, "mute.json"), args.target ?? undefined);
      console.log(
        cleared.length === 0
          ? "本来就没有静音。"
          : `已解除：${cleared.join("、")}（被它静音时攒下的消息仍在 inbox 里）`,
      );
      return 0;
    }

    case "gateway":
      await runGateway({ root: args.root });
      return 0;

    case "search": {
      const env = readSearchEnv(args.root);
      if (!env) {
        console.error(
          "没有搜索凭据：写 secrets/search.env（GENG_SEARCH_TOKEN、DEEPSEEK_API_KEY，可选 GENG_SEARCH_BIND、GENG_SEARCH_DAILY）",
        );
        return 2;
      }
      await startSearchServer({ root: args.root, env });
      return 0;
    }

    default:
      console.error(`未知命令 ${args.cmd}`);
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ExpectedError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
