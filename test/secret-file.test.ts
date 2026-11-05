import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { secretFileFor } from "../internal/secret.ts";

test("a model key never lands in the file the container is handed", () => {
  const root = "/repo";
  // `--env-file` goes into the container, so a key here is one `env` away from the agent
  assert.equal(secretFileFor(root, "alice", "GENG_GH_APP_ID"), join(root, "secrets", "alice.env"));
  assert.equal(secretFileFor(root, "alice", "OPENCODE_API_KEY"), join(root, "secrets", "alice.model.env"));
  // every name the daemon would accept as the key goes to the same place
  for (const name of ["GENG_MODEL_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]) {
    assert.equal(secretFileFor(root, "alice", name), join(root, "secrets", "alice.model.env"), name);
  }
  // per instance, not per machine
  assert.notEqual(secretFileFor(root, "alice", "OPENCODE_API_KEY"), secretFileFor(root, "bob", "OPENCODE_API_KEY"));
});
