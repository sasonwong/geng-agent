import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `deploy/update.sh` 只做三件会被别的东西替掉的事：pull、build、restart。这里把
// 这三个命令换成记账的替身，在真的 bash 里跑真的脚本。测的是脚本的决定，不是
// systemd 或 docker 的性格——那两样在 CI 上都没有。
//
// 为什么值得造这一套夹具：这三条旧行为在输出上和「升级成功」长得一模一样——
// 模板没重装、镜像没重建、重启失败被吞——只有看它到底敲了什么命令才分得出来。

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UNITS = ["geng@.service", "geng-gateway.service", "geng-search.service"];

const GIT_SHIM = `#!/usr/bin/env bash
printf 'git %s\\n' "$*" >> "$GENG_TEST_LOG"
case "$1" in
  pull) exit "\${GENG_TEST_PULL_EXIT:-0}" ;;
  status) printf '%s' "\${GENG_TEST_DIRTY:-}"; exit 0 ;;
  symbolic-ref)
    [ -n "\${GENG_TEST_DETACHED:-}" ] && exit 1
    printf '%s\\n' "\${GENG_TEST_BRANCH:-main}"; exit 0 ;;
  rev-parse) printf 'abc1234\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`;

const SYSTEMCTL_SHIM = `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$GENG_TEST_LOG"
args=()
for a in "$@"; do
  case "$a" in
    --user|--quiet|--no-legend|--plain|--all|--state=*|--no-block) ;;
    *) args+=("$a") ;;
  esac
done
case "\${args[0]:-}" in
  daemon-reload) exit 0 ;;
  list-unit-files) printf '%s\\n' "\${GENG_TEST_ENABLED:-}"; exit 0 ;;
  list-units) exit 0 ;;
  is-enabled) exit "\${GENG_TEST_IS_ENABLED_EXIT:-0}" ;;
  restart)
    if [ -n "\${GENG_TEST_FAIL_RESTART:-}" ] && [[ "\${args[1]:-}" == *"\${GENG_TEST_FAIL_RESTART}"* ]]; then exit 1; fi
    exit 0 ;;
  show) printf 'active\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`;

const BUILD_STUB = `#!/usr/bin/env bash
printf 'build %s\\n' "\${GENG_IMAGE:-}" >> "$GENG_TEST_LOG"
`;

interface Harness {
  dir: string;
  repo: string;
  bin: string;
  home: string;
  unitDir: string;
  log: string;
}

const made: string[] = [];
after(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = (p: string) => p.replace(/\\/g, "/");

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "geng-update-"));
  made.push(dir);
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const unitDir = join(home, ".config", "systemd", "user");
  const log = join(dir, "calls.log");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(unitDir, "default.target.wants"), { recursive: true });
  copyFileSync(join(REPO, "deploy", "update.sh"), join(repo, "deploy", "update.sh"));
  for (const u of UNITS) copyFileSync(join(REPO, "deploy", u), join(repo, "deploy", u));
  writeFileSync(join(repo, "deploy", "build.sh"), BUILD_STUB);
  writeFileSync(join(bin, "git"), GIT_SHIM);
  writeFileSync(join(bin, "systemctl"), SYSTEMCTL_SHIM);
  for (const p of [
    join(repo, "deploy", "update.sh"), join(repo, "deploy", "build.sh"),
    join(bin, "git"), join(bin, "systemctl"),
  ]) chmodSync(p, 0o755);
  // §4 装进来的三份 unit：已经过时，还带着没换的占位符。
  for (const u of UNITS) {
    writeFileSync(join(unitDir, u), "# STALE 装的时候的旧模板\nExecStart=@NODE@ @ROOT@/cmd/geng/index.ts daemon\n");
  }
  return { dir, repo, bin, home, unitDir, log };
}

function run(h: Harness, extra: Record<string, string> = {}) {
  const sep = process.platform === "win32" ? ";" : ":";
  const r = spawnSync("bash", ["deploy/update.sh"], {
    cwd: h.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${h.bin}${sep}${process.env.PATH ?? ""}`,
      HOME: posix(h.home),
      XDG_CONFIG_HOME: posix(join(h.home, ".config")),
      GENG_TEST_LOG: posix(h.log),
      ...extra,
    },
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    log: existsSync(h.log) ? readFileSync(h.log, "utf8") : "",
  };
}

test("the update script is valid bash", () => {
  const r = spawnSync("bash", ["-n", "deploy/update.sh"], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("an upgrade reinstalls every unit template before it restarts anything", () => {
  const h = harness();
  const r = run(h, {
    GENG_TEST_ENABLED: "geng@alice.service enabled enabled\ngeng-gateway.service enabled enabled",
  });
  assert.equal(r.code, 0, r.out);
  for (const u of UNITS) {
    const body = readFileSync(join(h.unitDir, u), "utf8");
    assert.ok(!body.includes("STALE"), `${u} 还是旧模板`);
    assert.ok(!body.includes("@ROOT@") && !body.includes("@NODE@"), `${u} 的占位符没换`);
    assert.match(body, /cmd\/geng\/index\.ts/);
  }
  // 这三行都是这次更新才进模板的；只 restart 不重装的话，一行都看不到。
  assert.match(readFileSync(join(h.unitDir, "geng@.service"), "utf8"), /KillMode=control-group/);
  assert.match(readFileSync(join(h.unitDir, "geng-gateway.service"), "utf8"), /NODE_USE_ENV_PROXY=1/);
  assert.match(readFileSync(join(h.unitDir, "geng-search.service"), "utf8"), /RuntimeDirectory=geng/);
  assert.match(r.log, /systemctl --user daemon-reload/);
  assert.match(r.log, /systemctl --user restart geng@alice\.service/);
  assert.match(r.log, /systemctl --user restart geng-gateway\.service/);
  assert.equal(/restart geng-search/.test(r.log), false, "没启用的 search 不该被重启");
});

test("a restart that fails stops the upgrade instead of printing that it finished", () => {
  const h = harness();
  const r = run(h, {
    GENG_TEST_ENABLED: "geng-gateway.service enabled enabled",
    GENG_TEST_FAIL_RESTART: "gateway", // 两种拼法都要能被替身认出来
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.out.includes("更新完成"), false, "失败时不能报成功");
});

test("every image the running instances name is rebuilt", () => {
  const h = harness();
  for (const [name, body] of [
    ["alice", JSON.stringify({ schema: 1, container: { image: "geng-agent:9.9" } })],
    ["bob", JSON.stringify({ schema: 1, container: { image: "geng-agent:latest" } })],
    ["broken", "{oops"],
  ] as const) {
    mkdirSync(join(h.repo, "data", name), { recursive: true });
    writeFileSync(join(h.repo, "data", name, "policy.json"), body);
  }
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.log, /build geng-agent:9\.9/, "自定义 tag 的实例不能被永远留在旧镜像上");
  assert.match(r.log, /build geng-agent:latest/);
});

test("a dirty checkout refuses to upgrade before it rebuilds anything", () => {
  const h = harness();
  const r = run(h, { GENG_TEST_DIRTY: " M deploy/policy.json" });
  assert.notEqual(r.code, 0);
  assert.equal(/build /.test(r.log), false, "连镜像都不该动");
});

test("a detached HEAD refuses to upgrade", () => {
  const h = harness();
  const r = run(h, { GENG_TEST_DETACHED: "1" });
  assert.notEqual(r.code, 0);
});
