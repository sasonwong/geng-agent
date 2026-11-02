import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFiles, scanLogBodies } from "../internal/doctor.ts";

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

test("scanLogBodies: 报十条就够了，但要说还有几条没列出来", () => {
  const root = tree((r) => {
    for (let i = 0; i < 12; i++) writeFileSync(join(r, `${i}.log`), "ghp_" + "e".repeat(36));
  });
  const scan = scanLogBodies(root);
  assert.equal(scan.hits.length, 10);
  assert.equal(scan.more, 2);
  rmSync(root, { recursive: true, force: true });
});
