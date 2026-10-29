import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupRepos, commit, repo, scan } from "../tools/gate/fixture.ts";

// 规则表（tools/gate/patterns.mjs）的测试。与 gate.test.ts 里那三条结构检查分开：
// 一边坏了，应该一眼看出是哪一边。夹具，以及它为什么不能继承这台机器的 git 配置，
// 在 tools/gate/fixture.ts。
//
// 值一律运行时拼，不写字面量：这个测试文件本身也在门的扫描范围里，写一个真的
// token 进去，门会在测门的时候先把测试文件抓住。
const TOKEN = ["gh", "p_", "A".repeat(24)].join("");

after(cleanupRepos);

test("a token in a tracked file stops it, and the log says where but never what", () => {
  const dir = repo();
  commit(dir, { "notes.md": `调用时带上 ${TOKEN}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /GitHub 令牌: notes\.md:1/);
  // 这条门的输出会进公开 CI 日志。说位置，不说值。
  assert.equal(r.out.includes(TOKEN), false);
});

test("a rule name on its own does not leak the line either", () => {
  const dir = repo();
  const secret = ["hunter2", "hunter2"].join("");
  commit(dir, { "conf.json": `{\n  "password": "${secret}"\n}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /口令赋值: conf\.json:2/);
  assert.equal(r.out.includes(secret), false);
});

test("a documented placeholder is not a credential", () => {
  const dir = repo();
  commit(dir, {
    "README.md": 'api_key = "your-key-here"\nGENG_SEARCH_TOKEN=$(openssl rand -hex 16)\n',
  });
  assert.equal(scan(dir).code, 0);
});

test("a nine-digit number is a warning, not a wall", () => {
  const dir = repo();
  const serial = ["123456", "700"].join("");
  commit(dir, { "notes.md": `序号 ${serial} 是这一批里的第三个\n` });
  const r = scan(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /gate: ok（1 个文件，1 个提交身份，1 条低级别警告）/);
  assert.match(r.out, /警告 长数字 ID: notes\.md:1/);
});

test("a key glued to Chinese text is caught here even though the scanner misses it", () => {
  // 这条钉的是与 audit/patterns.py 之间唯一一处有意的差异：Python 的 \b 是 Unicode
  // 的，`密` 算词字符，所以 `密码sk-…` 前面没有边界，扫描器漏；门的 \b 是 ASCII 的，
  // 抓得住。门是合并前跑的那一侧，比报告严是对的。
  const dir = repo();
  commit(dir, { "notes.md": `密码${TOKEN}先记在这\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /GitHub 令牌: notes\.md:1/);
  assert.equal(r.out.includes(TOKEN), false);
});

test("an empty file and a file of placeholders are both silent", () => {
  const dir = repo();
  commit(dir, { "empty.md": "", "sample.md": "example.com / 127.0.0.1 / sk-...\n" });
  assert.equal(scan(dir).code, 0);
});

test("a token on a very long line is still caught", () => {
  // 压过的 JSON、一行的 env 导出就是这种形状。这一条钉的是「长行不是免检」：
  // 身份类规则在长行上会停手（噪音），凭据类不会。
  const dir = repo();
  const pad = "abcdef".repeat(110); // 660 字符，且不含九位数字
  commit(dir, { "big.json": `{"k":"${TOKEN}","pad":"${pad}"}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /GitHub 令牌: big\.json:1/);
  assert.equal(r.out.includes(TOKEN), false);
});

test("the noisy rules stand down on a very long line", () => {
  // 同一行长度下，九位数字不再报——minified 文本里到处是数字，报了只会让人把门关掉。
  // 短行上它照旧是「警告」（见上一条）。
  const dir = repo();
  const pad = "abcdef".repeat(110); // 660 字符，且不含九位数字
  const serial = ["123456", "700"].join("");
  commit(dir, { "big.json": `{"n":${serial},"pad":"${pad}"}\n` });
  assert.equal(scan(dir).code, 0);
});

test("the documentation ranges are examples, not a machine", () => {
  // 文档写示例 IP 就用这三段（RFC 5737）；它们和「干净」长一个样，所以只能靠测试钉住。
  const dir = repo();
  commit(dir, { "doc.md": "示例地址：192.0.2.7、198.51.100.1、203.0.113.9；内网 10.0.0.1、192.168.1.1\n" });
  assert.equal(scan(dir).code, 0);
});

test("a public address is still a fingerprint", () => {
  const dir = repo();
  const ip = [8, 8, 4, 4].join("."); // 运行时拼，这个文件自己也在门的扫描范围里
  commit(dir, { "notes.md": `那台机器是 ${ip}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /公网 IPv4: notes\.md:1/);
  assert.equal(r.out.includes(ip), false);
});

test("a row of identical digits is a placeholder, not an id", () => {
  // 文档里写示例 id 常这么写。这条是有意的假阴性：宁可漏一个九位同数字，
  // 也不要让每篇文档里的示例都变成警告。
  const dir = repo();
  const id = "1".repeat(9);
  commit(dir, { "doc.md": `示例里 id 就写成 ${id}\n` });
  assert.equal(scan(dir).code, 0);
});
