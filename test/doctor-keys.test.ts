import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE, botWiring, keyFiles, scanLogBodies, v4Range, rangeOpenUnder, probeEgressDetail } from "../internal/doctor.ts";
import { botIssues } from "../internal/bots.ts";

function tree(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  build(root);
  return root;
}

test("the docker probe extracts the gateway ip, not a whole route line", () => {
  const script = PROBE[2] ?? "";
  const m = /awk "([^"]+)"/.exec(script);
  const awk = m?.[1] ?? "";
  assert.notEqual(awk, "", "探针里应该有一条 awk");
  // JS strips a lone backslash from "\$3"; the shell then expands a bare $3 as a
  // positional parameter (empty), awk prints the entire route line, curl fails, and
  // the check always answers DOCKER_BLOCKED — the one shape that looks like safety.
  assert.match(awk, /print \\\$3/, "反斜杠要活到 shell 才对");
  const out = execFileSync(
    "sh",
    ["-c", `printf '%s\\n' 'default via 10.0.0.1 dev eth0' | awk "${awk}"`],
    { encoding: "utf8" },
  ).trim();
  assert.equal(out, "10.0.0.1");
});

test("one instance's doctor does not FAIL over another bot's typo", () => {
  const issues = botIssues(
    { alice: { token: "t" }, bob: { token: "" }, ops: { token: "t", chat: 1 } },
    () => true,
  );
  assert.deepEqual(botWiring("alice", issues), {
    own: [],
    others: ["bob：没有 token"],
  });
  assert.deepEqual(botWiring("bob", issues), {
    own: ["bob：没有 token"],
    others: [],
  });
  // ops and file-wide problems reach every instance, so they stay in this check
  const global = botIssues({ alice: { token: "t" }, ops: { token: "t" } }, () => true);
  assert.deepEqual(botWiring("alice", global).own, ["ops：没有 chat，运维消息发不出去"]);
  const noOps = botIssues({ alice: { token: "t" } }, () => true);
  assert.equal(botWiring("alice", noOps).own.length, 1, "「没有 ops」是文件级问题，归到每个实例");
});

test("keyFiles: 按文件名找，删掉 seen，也不往 node_modules 里钻", () => {
  const root = tree((r) => {
    mkdirSync(join(r, "workspace", "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(r, "inbox", "seen"), { recursive: true });
    writeFileSync(join(r, "workspace", "node_modules", "pkg", "server.key"), "x");
    writeFileSync(join(r, "inbox", "seen", "old.env"), "x");
    writeFileSync(join(r, "secrets.env"), "x");
    writeFileSync(join(r, "daemon.log"), "");
  });
  const hits = keyFiles(root);
  assert.deepEqual(hits, [join(root, "secrets.env")]);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: token 粘在日志里也能认出来（这条以前说「干净」）", () => {
  const root = tree((r) => {
    mkdirSync(join(r, "usage"), { recursive: true });
    writeFileSync(
      join(r, "daemon.log"),
      [
        "2026-11-01T08:00:00Z round ok",
        "curl https://api.example.com/?token=not-a-key",
        "telegram: getMe 失败 " + "123456789:" + "A".repeat(35),
      ].join("\n"),
    );
    writeFileSync(join(r, "usage", "symptoms.log"), "2026-11-01T08:01:00Z timeout lvl=1\n");
  });
  const scan = scanLogBodies(root);
  assert.equal(scan.hits.length, 1, scan.hits.join(" | "));
  assert.match(scan.hits[0] ?? "", /daemon\.log: Telegram bot token$/);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 私钥、GitHub token、sk- 都算形状；普通日志不算", () => {
  const root = tree((r) => {
    writeFileSync(
      join(r, "last-stderr.log"),
      [
        // 拼出来而不是写死：写死会在 `npm run gate` 里被当成真的私钥块（它就该这样）。
        ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" "),
        "ghp_" + "a".repeat(36),
        "sk-proj-" + "b".repeat(24),
        "随便一行中文日志，没有 key",
      ].join("\n"),
    );
    writeFileSync(join(r, "notes.txt"), "ghp_" + "a".repeat(36));
  });
  const labels = scanLogBodies(root).hits.map((h) => h.split(": ")[1] ?? "").sort();
  assert.deepEqual(labels, ["GitHub token", "sk- 形状的 key", "私钥"].sort());
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: .log 以外的正文不看，node_modules 里的 log 也不看", () => {
  const root = tree((r) => {
    mkdirSync(join(r, "workspace", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(r, "workspace", "node_modules", "pkg", "install.log"), "ghp_" + "c".repeat(36));
    writeFileSync(join(r, "last-output.txt"), "ghp_" + "c".repeat(36));
  });
  assert.deepEqual(scanLogBodies(root).hits, []);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 大日志只读尾巴，头部那句旧 token 不算（口径写在注释里）", () => {
  const root = tree((r) => {
    const head = "ghp_" + "d".repeat(36) + "\n";
    const padding = "填充行，让文件越过 8 MiB 的读尾巴界\n".repeat(400_000); // ~12 MiB
    const tail = "2026-11-01T08:00:00Z round ok\n";
    writeFileSync(join(r, "daemon.log"), head + padding + tail);
  });
  const scan = scanLogBodies(root);
  assert.deepEqual(scan.hits, []);
  // and this is what a person may see: 「干净」 must not cover 「其余的字节没人看过」
  assert.deepEqual(scan.truncated, ["daemon.log"]);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 轮转出来的那份也是日志，不是一个没人看的新名字", () => {
  // appendLine renames at 20 000 lines, so the *oldest* lines live in daemon.log.1 — a key
  // appended before the rotation is exactly the one that is no longer in daemon.log
  const root = tree((r) => {
    writeFileSync(join(r, "daemon.log"), "2026-11-01T08:00:00Z round ok\n");
    writeFileSync(join(r, "daemon.log.1"), "ghp_" + "f".repeat(36) + "\n");
  });
  const scan = scanLogBodies(root);
  assert.deepEqual(scan.hits.map((h) => h.split(": ")[1]), ["GitHub token"]);
  assert.match(scan.hits[0] ?? "", /daemon\.log\.1:/);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 报十条就够了，但要说还有几条没列出来", () => {
  const root = tree((r) => {
    for (let i = 0; i < 12; i++) writeFileSync(join(r, `${i}.log`), "ghp_" + "e".repeat(36));
  });
  const scan = scanLogBodies(root);
  assert.equal(scan.hits.length, 10);
  assert.equal(scan.more, 2);
  rmSync(root, { recursive: true, force: true });
});

test("v4Range 认得裸 IPv4 和 IPv4-mapped IPv6 两种写法", () => {
  assert.deepEqual(v4Range("127.0.1.0/24"), [0x7f000100, 0x7f0001ff]);
  assert.deepEqual(v4Range("0.0.0.0/0"), [0, 0xffffffff]);
  // ::ffff:0:0/96 在数值上就是整段 IPv4；/104 等于 v4 的 /8
  assert.deepEqual(v4Range("::ffff:0:0/96"), [0, 0xffffffff]);
  assert.deepEqual(v4Range("::ffff:7f00:0/104"), [0x7f000000, 0x7fffffff]);
  assert.deepEqual(v4Range("::ffff:127.0.0.1"), [0x7f000001, 0x7f000001]);
  assert.equal(v4Range("fc00::/7"), null, "纯 IPv6 不在这把 32 位尺子里");
  assert.equal(v4Range("999.999.999.999"), null);
});

test("探针没跑完时 detail 不说『直连断开，代理通』", () => {
  // 90s 超时 / spawn 失败都带 PROBE_FAILED 且 ok=false。旧实现让这类输出一路落到
  // 最后的 fallback，无条件下结论「直连断开，代理通」——一个根本没跑的探针被报成
  // 一次成功的代理检查。
  assert.equal(
    probeEgressDetail("PROBE_FAILED docker run 超时（90s），探针没有跑完", true, false),
    "探针没跑完，见『容器探针』",
  );
  assert.equal(
    probeEgressDetail("PROBE_FAILED spawn ENOENT", false, false),
    "探针没跑完，见『容器探针』",
  );
  // 没有标记、结果也不完整：最后的 fallback 要看 ok，不能一律报成功
  assert.equal(probeEgressDetail("半截输出", true, false), "探针结果不完整，无法判定");
  assert.equal(probeEgressDetail("PROXY_OK NET_DIRECT_BLOCKED", true, true), "直连断开，代理通");
});

test("rangeOpenUnder 看到危险网段里没被 deny 盖住的那一段", () => {
  // 旧检查只探基地址 127.0.0.0：把 deny 收窄到只盖 127.0.0.0/24，127.0.1.0/24
  // 明明通了，基地址却仍被挡住，于是那一段悄悄藏起来，doctor 说「没开」。
  assert.equal(rangeOpenUnder("127.0.0.0/8", ["0.0.0.0/0", "!127.0.0.0/24"]), true);
  // 直接把藏起来的那段当 danger 也一样报开
  assert.equal(rangeOpenUnder("127.0.1.0/24", ["0.0.0.0/0", "!127.0.0.1/32"]), true);
  // 整段被 !127.0.0.0/8 盖住时不该误报
  assert.equal(rangeOpenUnder("127.0.0.0/8", ["0.0.0.0/0", "!127.0.0.0/8"]), false);
  // IPv4-mapped 的 allow / deny 也要照同一把尺子算
  assert.equal(rangeOpenUnder("127.0.0.0/8", ["::ffff:0:0/96", "!::ffff:7f00:0/104"]), false);
  assert.equal(rangeOpenUnder("127.0.0.0/8", ["::ffff:0:0/96", "!::ffff:7f00:0/112"]), true);
});
