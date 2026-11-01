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
  const hits = scanLogBodies(root);
  assert.equal(hits.length, 1, hits.join(" | "));
  assert.match(hits[0] ?? "", /daemon\.log: Telegram bot token$/);
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
  const hits = scanLogBodies(root);
  const labels = hits.map((h) => h.split(": ")[1] ?? "").sort();
  assert.deepEqual(labels, ["GitHub token", "sk- 形状的 key", "私钥"].sort());
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: .log 以外的正文不看，node_modules 里的 log 也不看", () => {
  const root = tree((r) => {
    mkdirSync(join(r, "workspace", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(r, "workspace", "node_modules", "pkg", "install.log"), "ghp_" + "c".repeat(36));
    writeFileSync(join(r, "last-output.txt"), "ghp_" + "c".repeat(36));
  });
  assert.deepEqual(scanLogBodies(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("scanLogBodies: 大日志只读尾巴，头部那句旧 token 不算（口径写在注释里）", () => {
  const root = tree((r) => {
    const head = "ghp_" + "d".repeat(36) + "\n";
    const padding = "填充行，让文件越过 8 MiB 的读尾巴界\n".repeat(400_000); // ~12 MiB
    const tail = "2026-11-01T08:00:00Z round ok\n";
    writeFileSync(join(r, "daemon.log"), head + padding + tail);
  });
  assert.deepEqual(scanLogBodies(root), []);
  rmSync(root, { recursive: true, force: true });
});
