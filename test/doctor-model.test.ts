import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkInstance } from "../internal/doctor.ts";
import { makePaths } from "../internal/paths.ts";

// The chain's first entry *is* the primary: settings.json says which model pi records in
// the session, and the chain says which model the proxy will actually serve. When the two
// disagree nothing breaks — the round just runs on a model the transcript does not name,
// which is the kind of wrong that only shows up as "why was it so bad that day".
function fixture(): { root: string; p: ReturnType<typeof makePaths> } {
  const root = mkdtempSync(join(tmpdir(), "geng-doctor-model-"));
  const p = makePaths(root, "alice");
  mkdirSync(join(dirname(p.piDir), "pi"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(
    join(p.piDir, "settings.json"),
    JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "beam-free" }),
  );
  writeFileSync(
    join(root, "deploy", "providers.json"),
    JSON.stringify({
      opencode: "https://zen.example/openai/v1",
      "opencode-go": "https://go.example/openai/v1",
    }),
  );
  const line = (name: string, value: string): string => [name, value].join("=");
  writeFileSync(
    join(root, "secrets", "alice.model.env"),
    `${line("OPENCODE_API_KEY", "host-only-answer")}\n`,
  );
  return { root, p };
}

function check(root: string): ReturnType<typeof checkInstance>[number] | undefined {
  return checkInstance(root, "alice", false).find((c) => c.name === "模型回退");
}

test("no chain is a warning, not a failure", () => {
  const { root } = fixture();
  try {
    const found = check(root);
    assert.equal(found?.ok, false);
    assert.equal(found?.warnOnly, true, "没配回退被当成了故障");
    assert.match(String(found?.detail), /model\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chain that starts at the settings' model is fine, and the address comes from the table", () => {
  const { root } = fixture();
  try {
    writeFileSync(
      join(root, "secrets", "alice.model.json"),
      JSON.stringify(["opencode-go/beam-free", "opencode/big-pickle"]),
    );
    const found = check(root);
    assert.equal(found?.ok, true, String(found?.detail));
    assert.match(String(found?.detail), /beam-free/);
    const address = checkInstance(root, "alice", false).find((c) => c.name === "模型密钥");
    assert.match(String(address?.detail), /https:\/\/go\.example\/openai\/v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chain whose first entry is another model is a failure, and says both", () => {
  const { root } = fixture();
  try {
    writeFileSync(
      join(root, "secrets", "alice.model.json"),
      JSON.stringify(["opencode/big-pickle", "opencode-go/beam-free"]),
    );
    const found = check(root);
    assert.equal(found?.ok, false);
    assert.equal(found?.warnOnly, false, "对齐错了只算提醒，那这条检查就没用了");
    assert.match(String(found?.detail), /big-pickle/);
    assert.match(String(found?.detail), /beam-free/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a provider the table does not know is a failure", () => {
  const { root } = fixture();
  try {
    writeFileSync(
      join(root, "secrets", "alice.model.json"),
      JSON.stringify(["opencode-go/beam-free", "nowhere/some-model"]),
    );
    const found = check(root);
    assert.equal(found?.ok, false);
    assert.match(String(found?.detail), /nowhere/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid reasoning effort is a failure with its own words", () => {
  const { root } = fixture();
  try {
    writeFileSync(
      join(root, "secrets", "alice.model.json"),
      JSON.stringify([
        "opencode-go/beam-free",
        { provider: "opencode", model: "big-pickle", reasoningEffort: "off" },
      ]),
    );
    const found = check(root);
    assert.equal(found?.ok, false);
    assert.match(String(found?.detail), /reasoningEffort 要/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hop's reasoning effort is shown, not just in the file", () => {
  const { root } = fixture();
  try {
    writeFileSync(
      join(root, "secrets", "alice.model.json"),
      JSON.stringify([
        "opencode-go/beam-free",
        { provider: "opencode", model: "big-pickle", reasoningEffort: "low" },
      ]),
    );
    const found = check(root);
    assert.equal(found?.ok, true, String(found?.detail));
    // The whole line, not a substring: a hop that sets no effort has to print exactly as it
    // did before, and only an exact assertion notices when that format drifts.
    assert.equal(
      String(found?.detail),
      "2 跳：opencode-go/beam-free → opencode/big-pickle（reasoningEffort=low）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
