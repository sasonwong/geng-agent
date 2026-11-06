import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CI 上不跑 docker（见 .github/workflows/ci.yml 的注释），所以镜像里这几条性质只能
// 从 Dockerfile 本身验。它们不是「写法偏好」，是构建时能不能真的挡住换包的性质：
// 版本钉死、校验和无条件生效、入口脚本语法正确且在缺东西时早失败。
const REPO = fileURLToPath(new URL("..", import.meta.url));
// git 在 Windows 上可能把工作区写成 CRLF；Docker 读到的始终是 LF，测试也该按 LF 看。
const docker = readFileSync(join(REPO, "Dockerfile"), "utf8").replace(/\r\n/g, "\n");
const checksums = readFileSync(join(REPO, "deploy", "checksums.txt"), "utf8").replace(/\r\n/g, "\n");

function heredocs(text: string): string[] {
  return [...text.matchAll(/RUN cat > \S+ <<'SH'\n([\s\S]*?)\nSH\n/g)].map((m) => m[1] ?? "");
}

test("the pi used to install packages is the same version the image runs", () => {
  const versions = [...docker.matchAll(/^ARG PI_VERSION=(.+)$/gm)].map((m) => (m[1] ?? "").trim());
  assert.equal(versions.length, 2, "packages 层和最终镜像各要声明一次");
  assert.deepEqual(new Set(versions).size, 1, "两层版本漂了，装出来的包目录会读不懂");
  assert.match(docker, /@earendil-works\/pi-coding-agent@\$\{PI_VERSION\}/, "npm 安装必须钉在同一版本");
});

test("both release tarballs are verified unconditionally, for both architectures", () => {
  // 旧的 `ARG PI_SHA256=""` + `if [ -n "$PI_SHA256" ]` 默认根本不校验。
  assert.equal(/ARG PI_SHA256/.test(docker), false);
  assert.equal(/if \[ -n "\$PI_SHA256" \]/.test(docker), false);
  assert.match(docker, /COPY deploy\/checksums\.txt/);
  assert.equal((docker.match(/sha256sum -c -/g) ?? []).length, 2, "gh 和 pi 各一次");
  assert.equal((docker.match(/\[ -n "\$(?:gh_sha|pi_sha)" \]/g) ?? []).length, 2, "查不到校验和要停");

  // 清单按文件名索引：四个 tarball 各一行，格式是标准 `<64hex>  <name>`。
  const rows = checksums.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  assert.equal(rows.length, 4);
  for (const row of rows) assert.match(row, /^[0-9a-f]{64}  \S+\.tar\.gz$/);
  for (const name of [
    "gh_2.103.2_linux_amd64.tar.gz", "gh_2.103.2_linux_arm64.tar.gz",
    "pi-linux-x64.tar.gz", "pi-linux-arm64.tar.gz",
  ]) assert.ok(checksums.includes(`  ${name}`), `清单里缺 ${name}`);
  // 未知架构不能偷偷拿 x64 凑。
  assert.match(docker, /\*\) echo ".+ 没有对应的 pi 二进制/);
});

test("the scripts baked into the image are valid sh", () => {
  const scripts = heredocs(docker);
  assert.equal(scripts.length, 3, "两个 credential helper 和 geng-pi");
  const dir = mkdtempSync(join(tmpdir(), "geng-dockerfile-"));
  try {
    for (const [i, body] of scripts.entries()) {
      const file = join(dir, `script-${i}.sh`);
      writeFileSync(file, body);
      const r = spawnSync("sh", ["-n", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the entrypoint refuses to start when its way out is missing", () => {
  const entry = heredocs(docker).find((s) => s.includes("exec pi")) ?? "";
  assert.match(entry, /set -eu/, "cp 失败不能继续 exec pi");
  assert.match(entry, /\[ -S "\$sock" \]/, "book socket 不在就别起两个 socat");
  assert.match(entry, /kill -0/, "socat 起来没起来要看一眼");
  assert.match(entry, /GENG_BOOK_SOCK/, "和 credential helper 用同一个路径");
  const helper = heredocs(docker).find((s) => s.includes("gh/token")) ?? "";
  assert.match(helper, /--max-time/, "socket 接了不答会一直挂住 git");
  // 静态 token 走同一个 socket：容器里没有副本，问一次用一次
  const cnb = heredocs(docker).find((s) => s.includes("/cnb/token")) ?? "";
  assert.match(cnb, /--max-time/, "socket 接了不答会一直挂住 git");
  assert.match(cnb, /username=cnb/, "cnb 的用户名是固定的，不是提示出来的");
  assert.match(docker, /credential "https:\/\/cnb\.cool"/, "git 要按 host 找得到它");
});
