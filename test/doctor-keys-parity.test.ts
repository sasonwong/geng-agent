import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// patterns.mjs 没有声明文件，而 tsconfig 不开 allowJs：这行让 tsc 跳过「隐式 any」，
// 类型由门自己的测试（gate-rules.test.ts）和这份对照测试一起兜。
// @ts-expect-error -- tools/gate/patterns.mjs 没有 .d.mts
import { RULES } from "../tools/gate/patterns.mjs";
import { scanLogBodies } from "../internal/doctor.ts";

// 为什么有这个文件：internal/doctor.ts 的 SECRET_SHAPES 是从 tools/gate/patterns.mjs 的
// 凭据表里**复制**出来的七条（见 doctor.ts:315-320 的注释）。复制本身可以，安静地漂不行：
// 门那边加了一条凭据形状、doctor 这边没跟上，效果就是日志里真出现那种 key 时，
// 一项说「干净」的检查——这正是这张 PR 要修的那句假话，只是换了个地方。
//
// 两个方向都锁：
//   1. 门表里的**每一条**规则都必须在这张分类表里出现一次。门那边新加一条 → 这里红，
//      直到有人写下「doctor 该不该在日志里看它」，以及为什么。
//   2. 说「doctor 看得到」的那些，样本要真的被两边同时认出来（门的规则匹配 + doctor 的
//      scanLogBodies 报出来）。只比注释文字不算，得让两条正则各跑一遍。
//
// 不锁的：正则写法的等价性（doctor 的 gh 那一侧拆成两条、量词不同）。要合并成一份源，
// 得动门的 import 路径，那是另一张单；这里只要「漂了就红」，不要「必须长得一样」。
//
// 样本一律运行时拼：这个测试文件也在门的扫描范围里，把真形状写成字面量，门会先抓住它
// （和 gate-rules.test.ts、doctor-keys.test.ts 里同一个理由）。

/** 门表里 doctor 应该在日志里认出来的规则 -> [样本, doctor 报出来的标签]。 */
const COVERED: Record<string, { samples: string[]; label: string }> = {
  私钥块: { samples: [["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" ")], label: "私钥" },
  "AWS AK": { samples: ["AKIA" + "Q".repeat(16)], label: "AWS access key" },
  "sk- 密钥": { samples: ["sk-" + "a".repeat(24)], label: "sk- 形状的 key" },
  "GitHub 令牌": {
    // 门的一条规则管两种形状，doctor 那边拆成两条：两种都要证。
    samples: ["ghp_" + "b".repeat(36), "github_pat_" + "c".repeat(24)],
    label: "GitHub token",
  },
  "Slack 令牌": { samples: ["xoxb-" + "1".repeat(12)], label: "Slack token" },
  // 位数用一个拼出来的九位数：写死九位会被门上「长数字 ID」那条看（虽然它在假值表里）。
  "机器人 Token": { samples: ["1234567" + "89:" + "D".repeat(35)], label: "Telegram bot token" },
};

/** 门表里剩下的规则，逐条写为什么 doctor 的日志检查不该看它（或者为什么优先在门那边拦）。 */
const EXEMPT: Record<string, string> = {
  "Google AK": "本项目不调 Google 的 API；真在日志里出现只可能是别人粘进来的 key，不是这台机器上泄出去的",
  "Stripe Key": "不接 Stripe：日志里出现只可能是别人粘进来的 key，换掉它也不是这台机器的动作",
  JWT: "本项目不发 JWT；日志里出现的是别人的会话，删不掉也换不回来，报了也没有动作",
  连接串含口令: "连接串/赋值形状是日志常态，一条见谁都报的检查最后会被当背景噪音——这条留在门上",
  "Bearer 头": "Authorization 头在日志里天天有，搬进这条检查等于给自己造噪音，同上",
  Webhook: "本项目不发 discord/slack webhook；真粘进来一条，换掉它得去对方那边操作",
  密钥赋值: "赋值形状，doctor.ts:317-319 的注释里已写明为什么不搬",
  口令赋值: "赋值形状同「密钥赋值」：日志里 `password=…` 是常态形状，门的提交前拦才拦得住",
  "npm 令牌": "赋值形状；npm 不在运行实例里跑，日志里不该有 install 输出",
  "docker login": "命令形状；真出现说明已经有人在宿主上手动操作了，不是一条日志检查兜得住的",
  "公网 IPv4": "身份/环境指纹，不是 key；日志里的 IP 是正常内容，报了也不是「换掉」能解决的",
  手机号: "身份/环境指纹；日志正文里出现电话是内容不是泄漏，这条检查只讲 key",
  身份证号: "身份/环境指纹；同上，且这个仓库的日志里不会有身份证号",
  "会话 ID 赋值": "身份/环境指纹；chat id 在日志里是正常字段，认它等于每行都报",
  "对话文件名里的真实 ID": "身份/环境指纹；这些 id 本来就写在日志的文件名里",
  "备份主机标签": "身份/环境指纹；hostname 出现在日志里是常态，不是凭据",
  "快照 ID": "身份/环境指纹；快照哈希出现在日志里是备份那条路自己打的",
  "长数字 ID": "身份/环境指纹；是数字就会被这条误伤，门那边有假值表能压，日志里没有",
};

function labelsIn(logText: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "geng-parity-"));
  try {
    writeFileSync(join(root, "daemon.log"), logText + "\n");
    return scanLogBodies(root).map((h) => h.split(": ")[1] ?? "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("门表里每条规则都被分过类：新加一条凭据形状，这里先红", () => {
  const classified = [...Object.keys(COVERED), ...Object.keys(EXEMPT)].sort();
  const inGate = RULES.map((r: { name: string }) => r.name).sort();
  assert.deepEqual(classified, inGate);
  // 空理由不算分类
  for (const [name, why] of Object.entries(EXEMPT)) {
    assert.ok(why.length > 8, `${name} 的免检理由太短`);
  }
});

test("doctor 说要看的，两边的正则都真的认得出", () => {
  for (const rule of RULES as Array<{ name: string; re: RegExp }>) {
    const covered = COVERED[rule.name];
    if (!covered) continue;
    for (const sample of covered.samples) {
      // 样本得真的表达这条门的规则，否则「doctor 也认得出」证明不了任何事
      assert.ok(rule.re.test(sample), `样本没被门里的「${rule.name}」匹配：这条对照是假的`);
      assert.ok(
        labelsIn(sample).includes(covered.label),
        `doctor 的日志检查没报出「${covered.label}」（样本来自门规则「${rule.name}」）`,
      );
    }
  }
});

test("doctor 报的标签都在分类表里声明过：多出一条新的，说明它没对照过门", () => {
  const all = Object.values(COVERED).flatMap((c) => c.samples);
  const seen = new Set(labelsIn(all.join("\n")));
  const declared = new Set(Object.values(COVERED).map((c) => c.label));
  assert.deepEqual([...seen].sort(), [...declared].sort());
});
