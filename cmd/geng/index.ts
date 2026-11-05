#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runDaemon } from "../../internal/daemon.ts";
import { ExpectedError } from "../../internal/errors.ts";
import { runDoctorWithProbe } from "../../internal/doctor.ts";
import { initInstance } from "../../internal/init.ts";
import { makePaths } from "../../internal/paths.ts";
import { listInstances, printStatus, statusLine } from "../../internal/status.ts";
import { runGateway } from "../../internal/gateway.ts";
import { getMe } from "../../internal/telegram.ts";
import { readSearchEnv, startSearchServer } from "../../internal/search.ts";
import { describeConfig, loadMailConfig, readMailEnv } from "../../internal/mail.ts";
import { addBot, describeBot, editAllow, readBots } from "../../internal/bots.ts";
import { newToken, readEnvFile, secretFileFor, secretFiles, writeEnvValue } from "../../internal/secret.ts";
import { backupRepo, listSnapshots, maybeBackup, restore, restoredLooksWhole } from "../../internal/backup.ts";
import { loadPolicy } from "../../internal/policy.ts";
import { MODEL_KEY_VARS, modelKeyFile } from "../../internal/model.ts";
import type { InitOptions } from "../../internal/init.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `geng <command> [options]

  init <instance> [--image t] [--timeout-min n] [--model id] [--upstream url]
                                     建目录、落 policy、生成 secrets 模板；四个参数是这个实例的
                                     决定，模型 key 从环境变量读（不写在命令行上）
  daemon --instance <instance>       一直跑（调试用 geng-dev，见 AGENTS.md）
  status [<instance>|--all]          一屏看状态
  doctor <instance> [--fix] [--probe] [--restore-test]
                                     把不变量变成检查（--probe 起个容器真验挂载与出口，
                                     --restore-test 把最近一张快照恢复到临时目录再读回来）
  backup <instance> [--list]         立刻拍一张快照 / 列已有快照
  restore <instance> [<id>] --yes    恢复到 backup/<instance>.restore-<时间>/（默认最近一张；
                                     没有 --yes 不动手；不直接覆盖 data/，自己拷回去）
  gateway [--check]                  跑消息搬运（需要 secrets/bots.json）；--check 只验 token
  bots add <inst> [--token-stdin] [--listen all|mentions] [--allow 1,2] [--chat N]
                                     往 secrets/bots.json 里加一个 bot（token 从 stdin 读）
  bots allow <inst> add|rm <ids>     改白名单（逗号分隔）；只有 add 过的人才叫得醒它
  secrets init <inst> [--rotate]     生成 mail token（搜索的 token 已经取消：socket 就是授权）
  secrets set <inst> <NAME>          从 stdin 读一个值写进该去的地方（600）：模型 key 落
                                     secrets/<inst>.model.env，其余落 secrets/<inst>.env
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
  check: boolean;
  rest: string[];
}

/**
 * 子命令自己的选项。放在这里而不是全局 Args 上：它们对一个子命令有意义，对其余的没有，
 * 而全局开关每加一个，就多一个"不知道属于谁"的状态。
 */
const SUB_FLAG_VALUED = new Set([
  "--listen",
  "--allow",
  "--chat",
  // init: the four values that are about one instance rather than the project
  "--image",
  "--timeout-min",
  "--model",
  "--upstream",
]);
const SUB_FLAG_BOOL = new Set(["--token-stdin", "--rotate"]);

function parse(argv: string[]): Args {
  const first = argv[0] ?? "";
  const args: Args = {
    // the flag is in the command position, so the loop below (which starts at argv[1])
    // never sees it: `geng --help` used to answer "未知命令 --help"
    cmd: first === "-h" || first === "--help" ? "help" : first,
    instance: null,
    root: REPO_ROOT,
    fix: false,
    probe: false,
    restoreTest: false,
    list: false,
    yes: false,
    all: false,
    check: false,
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
    } else if (a === "--check") {
      args.check = true;
    } else if (a === "--yes") {
      args.yes = true;
    } else if (a === "--all") {
      args.all = true;
    } else if (a === "-h" || a === "--help") {
      args.cmd = "help";
    } else if (SUB_FLAG_VALUED.has(a)) {
      // 只有某个子命令认识的选项：原样留着，由它自己解释（未知的仍然报错）
      positional.push(a);
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      positional.push(v);
    } else if (SUB_FLAG_BOOL.has(a)) {
      positional.push(a);
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

/**
 * `init` 自己的四个值。放在这里而不是 parse() 里：其余子命令不认识它们，而一个"谁的都不属于"
 * 的全局开关，最后总会被某个子命令悄悄读走。
 */
function initArgs(rest: string[]): { instance: string | null; opts: InitOptions } {
  const opts: InitOptions = {};
  const left: string[] = [];
  const text = (flag: string, v: string): string => {
    if (v.trim() === "") throw new Error(`${flag} 不能是空字符串`);
    return v.trim();
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    const v = rest[i + 1];
    if (a === "--image" || a === "--timeout-min" || a === "--model" || a === "--upstream") {
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      i++;
      if (a === "--image") opts.image = text(a, v);
      else if (a === "--model") opts.model = text(a, v);
      else if (a === "--upstream") {
        opts.upstream = text(a, v);
        if (!/^https?:\/\//.test(opts.upstream)) throw new Error(`--upstream 要是 http(s) 地址，拿到 ${v}`);
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--timeout-min 要一个正整数（分钟），拿到 ${v}`);
        opts.timeoutMin = n;
      }
    } else if (a.startsWith("--")) {
      throw new Error(`init 不认识 ${a}`);
    } else {
      left.push(a);
    }
  }
  return { instance: left[0] ?? null, opts };
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
      // init's own flags are read here, before the instance name is taken from what is
      // left: `geng init --model x alice` and `geng init alice --model x` are the same.
      let parsed: { instance: string | null; opts: InitOptions };
      try {
        parsed = initArgs(args.rest);
      } catch (err) {
        console.error((err as Error).message);
        return 2;
      }
      const { instance, opts } = parsed;
      if (!instance) {
        console.error("用法：geng init <instance> [--image <tag>] [--timeout-min <n>] [--model <id>] [--upstream <url>]");
        return 2;
      }
      // A key in the environment is a key the operator does not have to paste into a file.
      // It is never a flag value: arguments land in shell history and in `ps`.
      const fromEnv = MODEL_KEY_VARS.map((n) => (process.env[n] ?? "").trim()).find((v) => v !== "");
      initInstance(args.root, instance, { ...opts, modelKey: fromEnv });
      const p = makePaths(args.root, instance);
      console.log(`已初始化 ${p.instance}`);
      console.log(`  数据     ${p.data}`);
      console.log(`  密钥     ${p.secrets}（填好之后再跑）`);
      console.log(
        `  模型     ${modelKeyFile(p)}${fromEnv ? "（key 已从环境写入）" : "（把 key 写进这里，或 export 后重跑 init）"}`,
      );
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

    case "bots": {
      // rest 里是去掉命令名之后的参数：["add", "<instance>", ...]
      const sub = args.rest[0] ?? "";
      // the instance is a positional after the subcommand, never the subcommand itself
      // (`geng bots add` used to create a bot called "add") and never a flag
      const second = args.rest[1] ?? "";
      const key = second.startsWith("-") ? "" : second;
      const flag = (name: string): string | null => {
        const at = args.rest.indexOf(`--${name}`);
        return at === -1 ? null : (args.rest[at + 1] ?? null);
      };
      if (sub === "add") {
        if (key === "") {
          console.error("用法：geng bots add <instance> [--token-stdin] [--listen all|mentions] [--allow 1,2] [--chat N]");
          return 2;
        }
        // 从 stdin 读，不走 argv：argv 在 ps 里是公开的。
        const token = (args.rest.includes("--token-stdin") ? readFileSync(0, "utf8") : "").trim();
        if (token === "") {
          console.error(
            "没有 token：把 BotFather 给的那串用管道送进来——\n" +
              `  echo '<token>' | geng bots add ${key} --token-stdin --allow <你的 id>`,
          );
          return 2;
        }
        const ids = flag("allow");
        const chat = flag("chat");
        const listen = flag("listen");
        if (listen !== null && listen !== "all" && listen !== "mentions") {
          console.error("--listen 只能是 all 或 mentions");
          return 2;
        }
        addBot(args.root, key, {
          token,
          ...(listen === null ? {} : { listen: listen as "all" | "mentions" }),
          ...(ids === null
            ? {}
            : {
                allow: ids
                  .split(",")
                  .map((x) => Number(x.trim()))
                  .filter((n) => Number.isFinite(n)),
              }),
          ...(chat === null ? {} : { chat: Number(chat) }),
        });
        console.log(`写好 secrets/bots.json 里的 ${key}：${describeBot(readBots(args.root)[key])}`);
        console.log("接着跑 `geng gateway --check`：它会对每个 token 调一次 getMe，只有那一步能证明 token 是对的。");
        return 0;
      }
      if (sub === "allow") {
        const op = args.rest[2] ?? "";
        const ids = (args.rest[3] ?? "")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isFinite(n));
        if (key === "" || (op !== "add" && op !== "rm") || ids.length === 0) {
          console.error("用法：geng bots allow <instance> add|rm <id,id>");
          return 2;
        }
        try {
          editAllow(args.root, key, op === "add" ? ids : [], op === "rm" ? ids : []);
        } catch (err) {
          console.error((err as Error).message);
          return 2;
        }
        console.log(`${key}：${describeBot(readBots(args.root)[key])}`);
        return 0;
      }
      console.error("用法：geng bots add <instance> … | geng bots allow <instance> add|rm <ids>");
      return 2;
    }

    case "secrets": {
      const sub = args.rest[0] ?? "";
      // same trap as `bots`: a bare `geng secrets init` used to write secrets/init.env
      const second = args.rest[1] ?? "";
      const instance = second.startsWith("-") ? "" : second;
      if (sub === "init") {
        if (instance === "") {
          console.error("用法：geng secrets init <instance> [--rotate]");
          return 2;
        }
        const rotate = args.rest.includes("--rotate");
        const files = secretFiles(args.root, instance);
        const written: string[] = [];
        if (rotate || (readEnvFile(files.mail).GENG_MAIL_TOKEN ?? "") === "") {
          writeEnvValue(files.mail, "GENG_MAIL_TOKEN", newToken());
          written.push("mail token（secrets/mail.env）");
        }
        if (written.length === 0) {
          console.log("没有要生成的（要换加 --rotate）。");
        } else {
          for (const w of written) console.log(`写了 ${w}`);
        }
        if ((readEnvFile(files.search).DEEPSEEK_API_KEY ?? "") === "") {
          console.log("还差 secrets/search.env 里的 DEEPSEEK_API_KEY——这个生成不出来，得去控制台拿。");
        }
        if (written.some((w) => w.startsWith("mail"))) {
          console.log(
            "Cloudflare Worker 那边要同一个值，别抄，直接管道：\n" +
              "  wrangler secret put GENG_MAIL_TOKEN < <(sed -n 's/^GENG_MAIL_TOKEN=//p' secrets/mail.env)",
          );
        }
        return 0;
      }
      if (sub === "set") {
        const name = args.rest[2] ?? "";
        if (instance === "" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
          console.error(
            "用法：echo '<值>' | geng secrets set <instance> <NAME>   （NAME 形如 GENG_GH_APP_ID；模型 key 写 OPENCODE_API_KEY，会自动落进 model.env）",
          );
          return 2;
        }
        const value = readFileSync(0, "utf8").trim();
        if (value === "") {
          console.error("没有值：从 stdin 读——echo '<值>' | geng secrets set <instance> <NAME>");
          return 2;
        }
        const file = secretFileFor(args.root, instance, name);
        writeEnvValue(file, name, value);
        // 只报长度，不回显：这条输出会留在 shell 历史里。
        console.log(`写进 ${file}：${name}（${value.length} 字符，600）。`);
        return 0;
      }
      console.error("用法：geng secrets init <instance> [--rotate] | geng secrets set <instance> <NAME>");
      return 2;
    }

    case "gateway": {
      if (args.check) {
        const bots = readBots(args.root);
        const names = Object.keys(bots);
        const mailCfg = loadMailConfig(args.root);
        const mailEnv = readMailEnv(args.root);
        if (names.length === 0 && mailCfg === null) {
          console.error(
            `没有 bot 也没有信箱：先写 ${join(args.root, "secrets", "bots.json")} 或 secrets/mail.json`,
          );
          return 2;
        }
        let bad = 0;
        if (mailCfg !== null) {
          // a mailbox with no token accepts nothing, and it fails silently from outside
          if (mailEnv === null) {
            console.error("FAIL mail: 没有 token（secrets/mail.env 的 GENG_MAIL_TOKEN）");
            bad++;
          } else {
            for (const line of describeConfig(mailCfg)) {
              console.log(`ok   mail       ${line}  bind=${mailEnv.bind.host}:${mailEnv.bind.port}`);
            }
          }
        }
        for (const name of names) {
          const token = bots[name]?.token ?? "";
          if (token === "") {
            console.error(`FAIL ${name}: 没有 token`);
            bad++;
            continue;
          }
          try {
            const me = await getMe(token);
            const chat = bots[name]?.chat;
            console.log(`ok   ${name.padEnd(10)} @${me.username}${chat ? `  chat=${chat}` : "  chat=未设（它给 bot 发第一条消息后自动记住）"}`);
          } catch (err) {
            console.error(`FAIL ${name}: ${(err as Error).message}`);
            bad++;
          }
        }
        return bad === 0 ? 0 : 1;
      }
      await runGateway({ root: args.root });
      return 0;
    }

    case "search": {
      const env = readSearchEnv(args.root);
      if (!env) {
        console.error(
          "没有搜索凭据：写 secrets/search.env（DEEPSEEK_API_KEY，可选 GENG_SEARCH_SOCKET、GENG_SEARCH_DAILY）",
        );
        return 2;
      }
      const server = await startSearchServer({ root: args.root, env });
      // a listening server is not a reason to keep running: main() ends in
      // process.exit, which would close the port a second after it opened
      const stop = () => {
        server.close();
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      await new Promise<void>(() => {});
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
