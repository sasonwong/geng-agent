import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { metaCode, runDoctorWithProbe } from "../internal/doctor.ts";

// The metadata check used to read curl's exit status, and a 403 from our own proxy exits 0
// — so "the proxy refused" and "the host answered" produced the same FAIL. The probe now
// reports the status code and the decision is here, where a test can hold it.

test("a status code is what the probe reports, and 000 is the absence of one", () => {
  assert.equal(metaCode("META_CODE=403"), "403");
  assert.equal(metaCode("META_CODE=000"), "000");
  // no line at all: the script did not reach that step, which is not "it was blocked"
  assert.equal(metaCode("PROBE_FAILED"), null);
  // a line that is not a status code is not a status code
  assert.equal(metaCode("META_CODE=abc"), null);
});

async function line(probeOut: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "geng-meta-"));
  const oldPath = process.env.PATH;
  const oldOut = process.env.GENG_TEST_PROBE_OUT;
  try {
    execFileSync("git", ["init", "-q", root]);
    for (const d of ["image/extensions", "data/t", "bin"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "data", "t", "policy.json"), JSON.stringify({}));
    const out = join(root, "probe.out");
    const docker = join(root, "bin", "docker");
    writeFileSync(docker, '#!/bin/sh\n/bin/cat "$GENG_TEST_PROBE_OUT"\n');
    chmodSync(docker, 0o755);
    process.env.PATH = `${join(root, "bin")}:${oldPath ?? ""}`;
    process.env.GENG_TEST_PROBE_OUT = out;
    writeFileSync(out, probeOut);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "));
    try {
      await runDoctorWithProbe({ root, instance: "t", fix: false, probe: true, restoreTest: false });
    } finally {
      console.log = orig;
    }
    return lines.find((l) => l.includes("云元数据")) ?? "<没有 云元数据 这一行>";
  } finally {
    process.env.PATH = oldPath;
    if (oldOut === undefined) delete process.env.GENG_TEST_PROBE_OUT;
    else process.env.GENG_TEST_PROBE_OUT = oldOut;
    rmSync(root, { recursive: true, force: true });
  }
}

test("no route (000) is the answer this check wants", async () => {
  assert.match(await line("META_CODE=000"), /^ok/);
});

test("a refusal from the proxy is not a reachable host — but a 403 that answered is", async () => {
  // what the proxy's own 403 looks like once the status is read properly
  const refused = await line("META_CODE=403");
  assert.match(refused, /^FAIL/);
  assert.match(refused, /HTTP 403/);
});

test("the probe not reporting a code is not permission to pass", async () => {
  const missing = await line("PROBE_FAILED");
  assert.match(missing, /^FAIL/);
  assert.match(missing, /没报 META_CODE/);
});
