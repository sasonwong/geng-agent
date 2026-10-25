#!/usr/bin/env node
import { resolve } from "node:path";
import { runDaemon } from "../../internal/daemon.ts";
import { runDoctor } from "../../internal/doctor.ts";
import { initInstance } from "../../internal/init.ts";
import { makePaths } from "../../internal/paths.ts";
import { listInstances, printStatus, statusLine } from "../../internal/status.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `geng <command> [options]

  init <instance>                    建目录、落 policy、生成 secrets 模板
  daemon --instance <instance>       一直跑（调试用 geng-dev，见 AGENTS.md）
  status [<instance>|--all]          一屏看状态
  doctor [<instance>] [--fix]        把不变量变成检查
  gateway                            阶段 2，未实现

通用选项：
  --root <path>                      仓库根目录（默认：本仓库）
`;

interface Args {
  cmd: string;
  instance: string | null;
  root: string;
  fix: boolean;
  all: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = {
    cmd: argv[0] ?? "",
    instance: null,
    root: REPO_ROOT,
    fix: false,
    all: false,
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
      printStatus(args.root, args.instance);
      return 0;
    }

    case "doctor": {
      if (!args.instance) {
        console.error("用法：geng doctor <instance> [--fix]");
        return 2;
      }
      return runDoctor(args.root, args.instance, args.fix);
    }

    case "gateway":
      console.error("gateway 属于阶段 2，还没写。");
      return 2;

    default:
      console.error(`未知命令 ${args.cmd}`);
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
