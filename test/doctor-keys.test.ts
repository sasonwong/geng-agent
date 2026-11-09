import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstance, keyFiles, scanLogBodies } from "../internal/doctor.ts";
import { defaultPolicy } from "../internal/policy.ts";

function tree(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  build(root);
  return root;
}

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

test("keyFiles: 工作台的 scratch 不算，workspace 的其余部分照扫", () => {
  // 被杀的轮次把测试根留在 `workspace/tmp`，里面有 `secrets/*.env` 夹具；这条检查是
  // "凭据不在 data 里"，不是"测试残留不在 data 里"。其余 workspace 仍然要扫：token 是
  // 能通过 socket 拿到、再用重定向写成文件的。
  const root = tree((r) => {
    mkdirSync(join(r, "workspace", "tmp", "geng-test-abc", "secrets"), { recursive: true });
    writeFileSync(join(r, "workspace", "tmp", "geng-test-abc", "secrets", "alice.env"), "x");
    mkdirSync(join(r, "workspace", "geng-agent"), { recursive: true });
    writeFileSync(join(r, "workspace", "geng-agent", "leak.env"), "x");
    mkdirSync(join(r, "book"), { recursive: true });
    writeFileSync(join(r, "book", "model.key"), "x");
  });
  assert.deepEqual(keyFiles(root), [join(root, "book", "model.key"), join(root, "workspace", "geng-agent", "leak.env")]);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 工作台的 scratch 不算，workspace 的其余部分照扫", () => {
  // 和 keyFiles 那条一个根因：这条检查是"凭据没写进 data"，不是"测试残留不算数"。
  // `workspace/tmp` 里被杀轮次留下的夹具 token 跟 fixture .env 是一回事，报它只会教人别读 warn。
  const root = tree((r) => {
    mkdirSync(join(r, "workspace", "tmp", "geng-test-abc"), { recursive: true });
    writeFileSync(join(r, "workspace", "tmp", "geng-test-abc", "setup.log"), "ghp_" + "c".repeat(36));
    mkdirSync(join(r, "workspace", "geng-agent"), { recursive: true });
    writeFileSync(join(r, "workspace", "geng-agent", "install.log"), "ghp_" + "d".repeat(36));
  });
  const hits = scanLogBodies(root).hits;
  assert.equal(hits.length, 1, hits.join(" | "));
  assert.match(hits[0] ?? "", /workspace\/geng-agent\/install\.log: /);
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

// The dangerous-range warning used to probe only the base address: `127.0.1.0/24` does
// not contain `127.0.0.1`, so loopback was open and the check stayed quiet.
test("a narrower allow rule that overlaps a dangerous range is still flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  const policy = join(root, "data", "alice", "policy.json");
  mkdirSync(join(root, "data", "alice"), { recursive: true });
  const base = defaultPolicy();
  writeFileSync(
    policy,
    JSON.stringify({ ...base, container: { ...base.container, proxyAllowCidrs: ["127.0.1.0/24"] } }),
  );

  const flagged = checkInstance(root, "alice", false).find((c) => c.name === "代理能进内网");
  assert.ok(flagged, "窄一点的 loopback 规则也要触发警告");
  assert.match(flagged!.detail, /127\.0\.0\.0\/8/);
  rmSync(root, { recursive: true, force: true });
});

test("an allow list that touches none of the ranges stays quiet", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  const policy = join(root, "data", "alice", "policy.json");
  mkdirSync(join(root, "data", "alice"), { recursive: true });
  const base = defaultPolicy();
  writeFileSync(
    policy,
    JSON.stringify({ ...base, container: { ...base.container, proxyAllowCidrs: ["192.0.2.0/24"] } }),
  );

  const flagged = checkInstance(root, "alice", false).find((c) => c.name === "代理能进内网");
  assert.equal(flagged, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("the default rules open the internet and close the ranges: no warning", () => {
  // 0.0.0.0/0 with a deny per range is the default; the warning must not fire on it
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  const policy = join(root, "data", "alice", "policy.json");
  mkdirSync(join(root, "data", "alice"), { recursive: true });
  writeFileSync(policy, JSON.stringify(defaultPolicy()));

  const flagged = checkInstance(root, "alice", false).find((c) => c.name === "代理能进内网");
  assert.equal(flagged, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("a range only partly closed by a deny still warns", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-"));
  const policy = join(root, "data", "alice", "policy.json");
  mkdirSync(join(root, "data", "alice"), { recursive: true });
  const base = defaultPolicy();
  writeFileSync(
    policy,
    JSON.stringify({
      ...base,
      container: { ...base.container, proxyAllowCidrs: ["0.0.0.0/0", "!10.9.0.0/16"] },
    }),
  );

  const flagged = checkInstance(root, "alice", false).find((c) => c.name === "代理能进内网");
  assert.ok(flagged, "只挡住一段的内网仍然是开的");
  assert.match(flagged!.detail, /10\.0\.0\.0\/8/);
  rmSync(root, { recursive: true, force: true });
});
