#!/usr/bin/env node
/**
 * Dev-only commands. Not part of the published package (see `files` in package.json).
 * Everything here either costs nothing or refuses to run when the real daemon is up.
 */
import { resolve } from "node:path";
import { runDaemon } from "../../internal/daemon.ts";
import { writeFakeState } from "../../internal/dev/fake.ts";
import { lockHeld } from "../../internal/lock.ts";
import { makePaths } from "../../internal/paths.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `geng-dev <command> --instance <name>

  packet    打印它这次醒来会看到的纸，不花钱
  once      前台跑一轮，用来验证 runner（挂载 / uid / session 落盘）
  fake      造一份有内容的假状态，用来试唤醒纸
             （只写自己没有的东西；--force 覆盖）

通用选项：
  --instance <name>   实例名
  --root <path>       仓库根目录（默认：本仓库）
`;

interface Args {
  cmd: string;
  instance: string | null;
  root: string;
  force: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { cmd: argv[0] ?? "", instance: null, root: REPO_ROOT, force: false };
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
    } else if (a === "--force") {
      args.force = true;
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

  if (args.cmd === "help" || args.cmd === "") {
    console.log(USAGE);
    return 0;
  }
  if (!args.instance) {
    console.error("缺 --instance");
    console.error(USAGE);
    return 2;
  }

  const paths = makePaths(args.root, args.instance);

  switch (args.cmd) {
    case "packet": {
      await runDaemon({ root: args.root, instance: args.instance, once: true, dry: true });
      return 0;
    }

    case "once": {
      if (await lockHeld(`${paths.data}/daemon.lock`)) {
        console.error("daemon 正在跑，先停掉它再手工跑一轮：systemctl --user stop geng@" + args.instance);
        return 1;
      }
      await runDaemon({ root: args.root, instance: args.instance, once: true });
      return 0;
    }

    case "fake": {
      const created = writeFakeState(paths, { force: args.force });
      if (created.length === 0) {
        console.log("什么都没写：状态已经存在。要覆盖就加 --force");
      } else {
        for (const f of created) console.log(`写入 ${f}`);
      }
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
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
