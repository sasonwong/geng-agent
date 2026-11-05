import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mailWiringProblem,
  newToken,
  readEnvFile,
  secretFileFor,
  writeEnvValue,
} from "../internal/secret.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "geng-secret-"));

test("an env file keeps its comments and only moves the line it was asked to move", () => {
  const d = dir();
  const file = join(d, "alice.env");
  writeFileSync(file, "# 这是注释\nOPENCODE_API_KEY=old\n# 中间一行\nOTHER=1\n");

  writeEnvValue(file, "OPENCODE_API_KEY", "new");
  writeEnvValue(file, "SOME_TOKEN", "tok");

  const text = readFileSync(file, "utf8");
  assert.match(text, /^# 这是注释$/m);
  assert.match(text, /^# 中间一行$/m);
  assert.equal(readEnvFile(file).OPENCODE_API_KEY, "new");
  assert.equal(readEnvFile(file).OTHER, "1");
  assert.equal(readEnvFile(file).SOME_TOKEN, "tok");
  // a secret file that is group/world readable is a secret in name only
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("模型 upstream 和 key 落进同一个 model.env，容器读不到", () => {
  const d = dir();
  const model = join(d, "secrets", "alice.model.env");
  assert.equal(secretFileFor(d, "alice", "OPENCODE_API_KEY"), model);
  // modelUpstream() 从 model.env 读 GENG_MODEL_UPSTREAM；写进 <inst>.env 的话没有任何
  // 读者，而那个文件反而会被 --env-file 注进容器。
  assert.equal(secretFileFor(d, "alice", "GENG_MODEL_UPSTREAM"), model);
  assert.equal(secretFileFor(d, "alice", "GENG_GH_APP_ID"), join(d, "secrets", "alice.env"));
});

test("重复的同名 env 行会被收成一行，新值说了算", () => {
  const d = dir();
  const file = join(d, "dup.env");
  // readEnvFile 是后写覆盖前写：只改第一行、把后面那行原样留着的话，旧值反而会在
  // 写完之后赢。
  writeFileSync(file, "# 头注释\nOPENCODE_API_KEY=first\nOTHER=1\nOPENCODE_API_KEY=second\n# 尾注释\n");
  writeEnvValue(file, "OPENCODE_API_KEY", "winner");
  assert.equal(readEnvFile(file).OPENCODE_API_KEY, "winner");
  const text = readFileSync(file, "utf8");
  assert.equal((text.match(/^OPENCODE_API_KEY=/gm) ?? []).length, 1, "重复行要折叠成一行");
  assert.match(text, /^OPENCODE_API_KEY=winner$/m);
  // 注释和别的行一个都不能少
  assert.match(text, /^# 头注释$/m);
  assert.match(text, /^OTHER=1$/m);
  assert.match(text, /^# 尾注释$/m);
});

test("readEnvFile 认得手写 .env 里的 export 前缀", () => {
  const d = dir();
  const file = join(d, "export.env");
  writeFileSync(
    file,
    [
      "# 注释",
      "export DEEPSEEK_API_KEY=ds-key",
      "EXPORT GENG_MODEL_UPSTREAM=https://example.invalid/v1",
      "  export   GENG_GH_APP_ID  =  123  ",
      "PLAIN=plain",
    ].join("\n") + "\n",
  );
  // 旧实现把键记成 "export DEEPSEEK_API_KEY"，于是这些名字全读成空，
  // 操作者被告知「没配」。
  assert.deepEqual(readEnvFile(file), {
    DEEPSEEK_API_KEY: "ds-key",
    GENG_MODEL_UPSTREAM: "https://example.invalid/v1",
    GENG_GH_APP_ID: "123",
    PLAIN: "plain",
  });
});

test("writeEnvValue 把 export NAME 和 NAME 当成同一个键折叠成一行", () => {
  const d = dir();
  const file = join(d, "collapse.env");
  writeFileSync(file, "# 头\nexport OPENCODE_API_KEY=old-1\nOTHER=1\nOPENCODE_API_KEY=old-2\n");
  writeEnvValue(file, "OPENCODE_API_KEY", "new");
  const text = readFileSync(file, "utf8");
  assert.equal(readEnvFile(file).OPENCODE_API_KEY, "new");
  assert.equal(
    (text.match(/^(export\s+)?OPENCODE_API_KEY=/gm) ?? []).length,
    1,
    "export 写法和裸写法是同一个键，必须折叠成一行",
  );
  assert.doesNotMatch(text, /old-1|old-2/, "旧的 export 行不能被留下来");
  assert.match(text, /^# 头$/m);
  assert.match(text, /^OTHER=1$/m);
});

test("writeEnvValue 拒绝带换行的值，文件一个字节都不改", () => {
  const d = dir();
  const file = join(d, "inject.env");
  const before = "# 头\nOPENCODE_API_KEY=keep\nOTHER=1\n";
  writeFileSync(file, before);
  // 一个从终端粘来的值能凭空写出第二把 GENG_MODEL_KEY，而 readEnvFile 后写覆盖前写。
  assert.throws(() => writeEnvValue(file, "OPENCODE_API_KEY", "ok\nGENG_MODEL_KEY=injected"), /换行/);
  assert.throws(() => writeEnvValue(file, "OPENCODE_API_KEY", "ok\rX=1"), /换行/);
  assert.equal(readFileSync(file, "utf8"), before, "拒绝时不能改动文件");
  assert.equal(readEnvFile(file).OPENCODE_API_KEY, "keep");
  assert.equal(readEnvFile(file).GENG_MODEL_KEY, undefined, "不许凭空注入第二把 key");
});

test("reading an env file ignores comments, blank lines and lines with no equals", () => {
  const d = dir();
  const file = join(d, "x.env");
  writeFileSync(file, "# a\n\nA=1\nB = 2 \nnot a kv line\n");
  assert.deepEqual(readEnvFile(file), { A: "1", B: "2" });
  assert.deepEqual(readEnvFile(join(d, "missing.env")), {});
});


test("a mailbox with only half of its wiring is reported, because neither half complains", () => {
  const mail = { "a@example.com": { instance: "alice", allow: ["you@example.org"] } };
  const env = { token: "t", bind: { host: "127.0.0.1", port: 8788 } };
  assert.equal(mailWiringProblem("alice", mail, env), null);
  assert.equal(mailWiringProblem("bob", null, null), null, "not using mail is fine");
  assert.match(mailWiringProblem("alice", mail, null) ?? "", /没有 token/);
  assert.match(mailWiringProblem("bob", mail, env) ?? "", /没有地址指向/);
});


test("generated tokens are long enough to not be guessable and differ each time", () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
