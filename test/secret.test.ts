import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mailWiringProblem,
  newToken,
  readEnvFile,
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

test("reading an env file ignores comments, blank lines and lines with no equals", () => {
  const d = dir();
  const file = join(d, "x.env");
  writeFileSync(file, "# a\n\nA=1\nB = 2 \nnot a kv line\n");
  assert.deepEqual(readEnvFile(file), { A: "1", B: "2" });
  assert.deepEqual(readEnvFile(join(d, "missing.env")), {});
});

test("a name written twice collapses to one line, and the written value wins", () => {
  const d = dir();
  const file = join(d, "x.env");
  // readEnvFile is last-wins, so a writer that replaced only the first occurrence left
  // the *old* value winning after its own write
  writeFileSync(file, "TOKEN=old\nOTHER=1\nTOKEN=older\n");

  writeEnvValue(file, "TOKEN", "new");

  assert.equal(readEnvFile(file).TOKEN, "new");
  assert.equal(readEnvFile(file).OTHER, "1");
  assert.equal(readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("TOKEN=")).length, 1);
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
