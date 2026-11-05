import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runDoctorWithProbe, toolsDigest } from "../internal/doctor.ts";

// `probe()` needs docker, so the branch it decides on — "mounted" — has no test in the
// normal suite. It does not need a real docker: what it reads is the probe's stdout, one
// line with EXT_COUNT= and EXT_DIGEST= on it. A stand-in `docker` that prints that line
// exercises the whole path from parsing to the "工具挂载" check. The commit that added the
// comparable() guard said so in its message; this is the missing test.

interface Fixture {
  root: string;
  env: { PATH?: string };
  /** Run the doctor with a probe, returning the "工具挂载" check as printed. */
  run: (probeOut: string) => Promise<string>;
  cleanup: () => void;
}

function fixture(files: Record<string, string>, opts: { barePath?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "geng-probe-"));
  const ext = join(root, "image", "extensions");
  const data = join(root, "data", "t");
  const bin = join(root, "bin");
  // `checkInstance` asks git whether data/ is tracked; without a repo it prints
  // "fatal: not a git repository" onto the test output. A bare repo is closer to real anyway.
  execFileSync("git", ["init", "-q", root]);
  for (const d of [ext, data, bin, join(data, "palimpsest"), join(data, "workspace")]) {
    mkdirSync(d, { recursive: true });
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(ext, name), body);
  // the only knob the branch under test uses
  writeFileSync(join(data, "policy.json"), JSON.stringify({ runner: "docker" }));

  const out = join(root, "probe.out");
  const docker = join(bin, "docker");
  // absolute /bin/cat: the stripped-PATH case below must still be able to print
  writeFileSync(docker, '#!/bin/sh\n/bin/cat "$GENG_TEST_PROBE_OUT"\n');
  chmodSync(docker, 0o755);

  const oldPath = process.env.PATH;
  const oldOut = process.env.GENG_TEST_PROBE_OUT;
  // barePath: PATH 里只剩 sh（软链）和那个假 docker，没有 ls/cksum/sha1sum —— 这就是
  // toolsDigest 返回 "" 的真实形状（`ls … || exit 0` 什么都没有 = 空串）。
  const shDir = join(root, "sh");
  mkdirSync(shDir, { recursive: true });
  symlinkSync("/bin/sh", join(shDir, "sh"));
  process.env.PATH = opts.barePath ? `${bin}:${shDir}` : `${bin}:${oldPath ?? ""}`;
  process.env.GENG_TEST_PROBE_OUT = out;

  return {
    root,
    env: process.env,
    run: async (probeOut: string) => {
      writeFileSync(out, probeOut);
      return findMountLine(root);
    },
    cleanup: () => {
      process.env.PATH = oldPath;
      if (oldOut === undefined) delete process.env.GENG_TEST_PROBE_OUT;
      else process.env.GENG_TEST_PROBE_OUT = oldOut;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function findMountLine(root: string): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await runDoctorWithProbe({ root, instance: "t", fix: false, probe: true, restoreTest: false });
  } finally {
    console.log = orig;
  }
  return lines.find((l) => l.includes("工具挂载")) ?? "<没有 工具挂载 这一行>";
}

const PROBE_BASE = "POLICY_HIDDEN STATE_OK EGRESS_OK META_BLOCKED DOCKER_BLOCKED";

test("两侧摘要都空 —— 不许读成「一致」，这是 #60 的那个假绿", async () => {
  // 宿主侧 PATH 里没有 sh/cksum → toolsDigest 抛 → ""；容器侧探针没打印摘要 → ""。
  // 旧代码走到 `mounted = onHost > 0 && "" === ""` → true → ok + `内容与宿主一致（）`。
  const f = fixture({ "mail.ts": "a", "websearch.ts": "b" }, { barePath: true });
  try {
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=0 EXT_DIGEST=`);
    assert.match(line, /^FAIL/);
    assert.match(line, /摘要没算出来（宿主那一侧是空的）/);
    assert.doesNotMatch(line, /内容与宿主一致/);
  } finally {
    f.cleanup();
  }
});

test("个数数出来了但容器侧摘要空（容器里没有 sha1sum 那种形状）—— 也说比不了", async () => {
  const f = fixture({ "mail.ts": "a", "websearch.ts": "b" });
  try {
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=2 EXT_DIGEST=`);
    assert.match(line, /^FAIL/);
    assert.match(line, /摘要没算出来（容器那一侧是空的）/);
  } finally {
    f.cleanup();
  }
});

test("宿主自己算不出摘要（PATH 被剥光的那种形状）时，也不许冒充一致", async () => {
  const f = fixture({});
  try {
    // 宿主 image/extensions 是空目录 → onHost === 0 走的是另一条分支，这里先确认它不绿
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=1 EXT_DIGEST=${"a".repeat(40)}`);
    assert.match(line, /^FAIL/);
    assert.match(line, /宿主 image\/extensions 里没有/);
  } finally {
    f.cleanup();
  }
});

test("摘要真的一样才绿，绿的时候把宿主摘要印出来", async () => {
  const f = fixture({ "mail.ts": "a", "websearch.ts": "b" });
  try {
    const host = toolsDigest(join(f.root, "image", "extensions"));
    assert.match(host, /^[0-9a-f]{40}$/);
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=2 EXT_DIGEST=${host}`);
    assert.match(line, /^ok/);
    assert.match(line, new RegExp(host.slice(0, 8)));
  } finally {
    f.cleanup();
  }
});

test("个数相同、内容不同 —— 红，并且说清是旧挂载/半同步", async () => {
  const f = fixture({ "mail.ts": "a", "websearch.ts": "b" });
  try {
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=2 EXT_DIGEST=${"c".repeat(40)}`);
    assert.match(line, /^FAIL/);
    assert.match(line, /个数相同但内容不同/);
  } finally {
    f.cleanup();
  }
});

test("挂载整个缺了：目录不在时探针给的是 count=0 + `da39a3ee…`（空输入的 sha1），那句「挂载缺了」是活的", async () => {
  // 实测（`sh -c '(cd /nonexistent && cksum ./*.ts) | sha1sum | cut -c1-40'`）：子 shell 失败
  // 输出为空，但 sha1sum 对空输入照样给 40 位 `da39a3ee…`。所以容器侧摘要是**非空**的，
  // `comparable` 为真，落到下面这条具体的分支——它不是死代码。
  const f = fixture({ "mail.ts": "a" });
  try {
    const line = await f.run(`${PROBE_BASE} EXT_COUNT=0 EXT_DIGEST=da39a3ee5e6b4b0d3255bfef95601890afd80709`);
    assert.match(line, /^FAIL/);
    assert.match(line, /挂载缺了/);
    // 这句为什么不能软化：容器里 0 个挂载时 pi 收到不存在的 -e 会 exit(1)，agent 起不来。
    assert.match(line, /exit\(1\)/);
  } finally {
    f.cleanup();
  }
});

test("探针一个字都没吐出来 ≠ 一切正常", async () => {
  const f = fixture({ "mail.ts": "a" });
  try {
    const line = await f.run("");
    assert.match(line, /^FAIL/);
    assert.match(line, /探针没数出来/);
  } finally {
    f.cleanup();
  }
});
