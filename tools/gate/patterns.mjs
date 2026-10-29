/**
 * The shapes that must not reach a public tree: credentials, and the fingerprints that
 * name a machine or a person.
 *
 * Why here: for a while the only thing between a token and this repository was a person
 * reading the diff. Everything in this table has already been seen somewhere it should
 * not have been — a key in a commit, a phone number in a doc, a home directory inside a
 * symlink. The gate is where a shape becomes a rule instead of a habit.
 *
 * Two properties this file must keep:
 *
 *   1. It never returns the matched text. Callers get a name and a severity, nothing
 *      else, because the gate's output goes into a public CI log and a log that repeats
 *      a leaked value is one more copy of it.
 *   2. It says what the tree contains now, not what the history contained. There is no
 *      baseline, no allowlist file, no "already accepted" list: a file like that is an
 *      index of the very values it is supposed to protect.
 *
 * Ported from the audit scanner's Python table, rule for rule, with one deliberate
 * difference. Python's `\b` is a Unicode word boundary; JavaScript's is ASCII. In a
 * repository whose docs are written in Chinese that changes what is found: `密码sk-…`
 * has no boundary before `sk` in Python (the 密 is a word character there), so the
 * scanner walks past a key that is glued to a Chinese character. The gate keeps
 * JavaScript's `\b` on purpose — it is the side that runs before every merge, and being
 * stricter than the report is the safe direction. Every other difference is a bug.
 *
 * The three "home directory" rules of the original table are deliberately absent:
 * `scan.mjs` already owns that shape, together with the placeholder-account list that
 * makes the documented examples legal. Two sources for one fact drift apart.
 */

const RULES = [
  // --- 凭据 ---
  { name: "私钥块", sev: "critical", src: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----` },
  { name: "AWS AK", sev: "critical", src: String.raw`\bAKIA[0-9A-Z]{16}\b` },
  { name: "sk- 密钥", sev: "critical", src: String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}` },
  { name: "GitHub 令牌", sev: "critical", src: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b` },
  { name: "Google AK", sev: "critical", src: String.raw`\bAIza[0-9A-Za-z_\-]{35}\b` },
  { name: "Slack 令牌", sev: "critical", src: String.raw`\bxox[baprs]-[A-Za-z0-9\-]{10,}` },
  { name: "机器人 Token", sev: "critical", src: String.raw`\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b` },
  { name: "Stripe Key", sev: "critical", src: String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b` },
  { name: "JWT", sev: "high", src: String.raw`\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}` },
  {
    name: "连接串含口令",
    sev: "critical",
    src: String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s:@/]+:[^\s@/]+@`,
    flags: "i",
  },
  { name: "Bearer 头", sev: "high", src: String.raw`authorization\s*:\s*['"]?Bearer\s+[A-Za-z0-9._\-]{10,}`, flags: "i" },
  {
    name: "Webhook",
    sev: "critical",
    src: String.raw`https://(?:discord(?:app)?\.com/api/webhooks|hooks\.slack\.com/services)/[A-Za-z0-9/_\-]{10,}`,
  },
  // 赋值类的两条各有两种拼法：带引号的（JSON/TS）和不带引号的（`.env`、YAML）。
  // 后者是 2026-10-29 补的：#28 只认带引号的值，而这个仓库存凭据的形状恰好是无引号的
  // `NAME=value`，真提交进来时最像凭据的几行是静默的。
  //
  // 不带引号的那种只收「看起来是字面量」的值：不以反引号、引号或 `${` 开头，长度 ≥12，
  // 后面不紧跟 `.` / `(` / `$`——那三种是表达式（`spec.token`、`newToken()`、`${VAR}` 是
  // 引用不是值），不是谁忘了引号。这条尾巴是量出来的：把门槛放宽到「任意 8 个字符」，
  // 这棵树的 106 个文件里有 8 处命中，全是 `process.env.X` / `readPassword(path)` 这类表达式，没有一处真值。
  // 名字那一侧要另写一条 `[A-Z][A-Z0-9_]*` 的形状，因为 `GENG_SEARCH_TOKEN` 里的
  // `token` 前面是 `_`，没有 `\b`。
  {
    name: "密钥赋值",
    sev: "critical",
    src: String.raw`(?:\b(?:access_?key_?id|secret_?access_?key|secret_?key|app_?secret|client_?secret|private_?token|api_?hash)\b|[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN))['"]?\s*[:=]\s*(?:['"][A-Za-z0-9/+=_\-]{12,}|(?![\x60'"$])[A-Za-z0-9/+=_\-]{12,}(?![.($]))`,
    flags: "i",
  },
  {
    name: "口令赋值",
    sev: "high",
    src: String.raw`(?:\b(?:password|passwd|pwd|api_?key|apikey|auth_?token|bot_?token|token)\b|[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|TOKEN|KEY))['"]?\s*[:=]\s*(?:['"][^'"\s]{8,}['"]|(?![\x60'"$])[A-Za-z0-9/+=_\-]{12,}(?![.($]))`,
    flags: "i",
  },
  { name: "npm 令牌", sev: "critical", src: String.raw`_authToken\s*=\s*\S{10,}`, flags: "i" },
  {
    name: "docker login",
    sev: "critical",
    src: String.raw`docker\s+login\s+-u\s+\S+\s+(?:-p|--password)\s+\S+`,
    flags: "i",
  },

  // --- 身份 / 环境指纹 ---
  // 文档段（RFC 5737）、CGNAT 与 benchmark 段都不是「哪台机器」：示例 IP 就住在那儿，
  // 报出来只会让人把这条规则关掉。`172.16-31` 已经遮住 Docker 的 `172.17.`。
  {
    name: "公网 IPv4",
    noisy: true,
    sev: "medium",
    src: String.raw`\b(?!(?:10|127|0|255)\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.0\.2\.|192\.168\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.)(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])(?:\.\d{1,3}){3}\b`,
  },
  { name: "手机号", noisy: true, sev: "high", src: String.raw`(?<![0-9])1[3-9]\d{9}(?![0-9])` },
  {
    name: "身份证号",
    sev: "critical",
    src: String.raw`(?<![0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])`,
  },
  {
    name: "会话 ID 赋值",
    noisy: true,
    sev: "high",
    src: String.raw`\b(?:chat|chat_?id|chatId|user_?id|userId)\b\s*[:=]\s*-?\d{5,}`,
    flags: "i",
  },
  { name: "对话文件名里的真实 ID", noisy: true, sev: "high", src: String.raw`/files/-?\d{6,}-\d{1,6}-|/people/-?\d{6,}\.jsonl` },
  {
    name: "备份主机标签",
    noisy: true,
    sev: "medium",
    src: String.raw`\bhostname['"]?\s*[:=]\s*['"][a-z0-9][a-z0-9\-]{0,14}['"]`,
    flags: "i",
  },
  { name: "快照 ID", noisy: true, sev: "medium", src: String.raw`\b[0-9a-f]{64}\b` },
  { name: "长数字 ID", noisy: true, sev: "low", src: String.raw`(?<![0-9A-Za-z_.\-])\d{9,11}(?![0-9])` },
].map((r) => ({ ...r, re: new RegExp(r.src, `u${r.flags ?? ""}`) }));

/** 一句话能说清楚的假值：项目自己写的示例、文档里的占位符。 */
const SYNTHETIC = new Set([
  "111", "-222", "-333", "-1001234", "-1001234567890", "123456789", "1234567890",
  "987654321", "-100", "-200", "-0",
  "123456:AAA", "234567:BBB", "345678:CCC",
  "alice", "bob", "carol", "agent", "someone", "other", "owner", "you", "x",
  "demo", "user", "host", "server", "example", "test",
]);

/** 出现即忽略整行：这一行本来就在说「这里应该填什么」。 */
const PLACEHOLDERS = [
  "example.com", "example.org", "example.net", "@example", "your-key", "YOUR_KEY",
  "your_key", "your-token", "YOUR_TOKEN", "<token>", "<your", "xxxx", "XXXX",
  "sk-...", "sk-xxx", "changeme", "CHANGEME", "placeholder", "dummy", "redacted",
  "REDACTED", "fake", "mock", "sample", "localhost", "127.0.0.1", "0.0.0.0",
  "${", "$(", "%s", "noreply",
];

/** 空着。真值复现时加进来，好让它重新被报出来。 */
const EXCEPTIONS = new Set();

/**
 * 比这个长的行多半是压过/打包过的产物。取舍不是「跳过」，而是「只跳一部分」：
 *
 * - 身份类规则（公网 IP、手机号、长数字、快照哈希、主机标签、会话 ID）在压缩文本里
 *   只会制造噪音——一行 minified 的 JS 里随便就有九位数字和几十位十六进制。跳过的
 *   就是标了 `noisy: true` 的那几条。
 * - 凭据类规则照扫。压缩过的 JSON、一行的 env 导出，恰好是真的会带 token 的形状；
 *   在这里跳过，等于给最需要看的那条路开后门。
 */
export const MAX_LINE = 600;

const allSameDigit = /^(\d)\1+$/;

function suppressed(name, val, path) {
  switch (name) {
    case "长数字 ID":
      // 九位全是同一个数字（1 或 9 反复写）是文档里的占位 id，不是谁的用户 id。
      return SYNTHETIC.has(val) || allSameDigit.test(val);
    case "会话 ID 赋值": {
      const nums = val.match(/-?\d{5,}/g) ?? [];
      return nums.length > 0 && nums.every((n) => SYNTHETIC.has(n) && !EXCEPTIONS.has(n));
    }
    case "对话文件名里的真实 ID": {
      const nums = val.match(/-?\d{6,}/g) ?? [];
      return nums.length > 0 && nums.every((n) => SYNTHETIC.has(n));
    }
    case "备份主机标签": {
      const host = /['"]([a-z0-9][a-z0-9\-]{0,14})['"]/.exec(val);
      return !host || SYNTHETIC.has(host[1]);
    }
    case "快照 ID":
      if (path.endsWith("package-lock.json")) return true;
      return new Set(val).size <= 2; // 全零或重复字符，是占位哈希
    default:
      return false;
  }
}

/**
 * One line of a tracked file -> the rules it breaks.
 *
 * `content` is the line as it appears in the file (not trimmed): the patterns match
 * against it, while length and placeholder checks use the trimmed form. The audit
 * scanner does the same, and the two must agree or a report cannot be checked.
 */
export function scanLine(path, content) {
  const text = content.trim();
  if (!text) return [];
  const long = text.length > MAX_LINE;
  const low = text.toLowerCase();
  if (PLACEHOLDERS.some((p) => low.includes(p.toLowerCase()))) return [];

  const hits = [];
  for (const rule of RULES) {
    if (long && rule.noisy) continue;
    const m = rule.re.exec(content);
    if (!m) continue;
    if (suppressed(rule.name, m[0], path)) continue;
    hits.push({ name: rule.name, sev: rule.sev });
  }
  return hits;
}

/**
 * Python's `str.splitlines()` — and not `split("\n")`, because a CRLF file would then
 * hand every line a trailing `\r` that the Python scanner never saw, and the line numbers
 * have to agree between the two or a report is not checkable.
 */
export function splitLines(text) {
  return text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}
