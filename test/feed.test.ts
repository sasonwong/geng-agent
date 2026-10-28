import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciOf,
  eventsOf,
  fileNameOf,
  mergeSeen,
  parsePrs,
  seenOf,
  textOf,
  writeEvents,
  type PrFacts,
  type Seen,
} from "../internal/feed.ts";
import { makePaths } from "../internal/paths.ts";

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 7,
    title: "fix(daemon): something",
    url: "https://example.invalid/pull/7",
    state: "OPEN",
    draft: false,
    review: "REVIEW_REQUIRED",
    head: "aaaaaaa",
    ci: "green",
    ...over,
  };
}

const BASELINE = (over: Partial<PrFacts> = {}): Seen => seenOf([pr(over)]);

test("a rollup is red as soon as one finished job failed, pending only if none did", () => {
  assert.equal(ciOf(undefined), "none");
  assert.equal(ciOf([]), "none");
  const run = (conclusion: string) => [{ __typename: "CheckRun", status: "COMPLETED", conclusion }];
  assert.equal(ciOf(run("SUCCESS")), "green");
  assert.equal(ciOf(run("SKIPPED")), "green");
  assert.equal(ciOf(run("FAILURE")), "red");
  assert.equal(ciOf([...run("SUCCESS"), ...run("FAILURE")]), "red");
  assert.equal(ciOf(run("IN_PROGRESS")), "pending");
  // red beats pending: a failure that already happened is a fact, a running job is not
  assert.equal(ciOf([...run("FAILURE"), ...run("QUEUED")]), "red");
  // StatusContext spells the same verdict `state`
  assert.equal(ciOf([{ __typename: "StatusContext", state: "ERROR" }]), "red");
  assert.equal(ciOf([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
});

test("only the fields it needs survive gh's output", () => {
  const parsed = parsePrs([
    { number: 3, title: "t", url: "u", state: "open", reviewDecision: "", headRefOid: "abc", statusCheckRollup: [] },
    { title: "没有编号" },
    "不是对象",
    null,
  ]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    number: 3,
    title: "t",
    url: "u",
    state: "OPEN",
    draft: false,
    review: "",
    head: "abc",
    ci: "none",
  });
  assert.deepEqual(parsePrs({ not: "an array" }), []);
});

test("the first sight of a pull request is the baseline, not news", () => {
  assert.deepEqual(eventsOf({}, [pr({ review: "APPROVED", ci: "red", state: "MERGED" })]), []);
});

test("an approval and a rejection knock; the same state twice does not", () => {
  const approved = eventsOf(BASELINE(), [pr({ review: "APPROVED" })]);
  assert.deepEqual(approved.map((e) => [e.kind, e.knock]), [["can-merge", true]]);
  // the snapshot now holds it, so the next run over the same facts says nothing
  const after = seenOf([pr({ review: "APPROVED" })]);
  assert.deepEqual(eventsOf(after, [pr({ review: "APPROVED" })]), []);

  assert.deepEqual(
    eventsOf(BASELINE(), [pr({ review: "CHANGES_REQUESTED" })]).map((e) => [e.kind, e.knock]),
    [["changes-requested", true]],
  );
});

test("losing an approval after its own push stays quiet", () => {
  // APPROVED → REVIEW_REQUIRED is what a push does; nobody is waiting on it
  const before = seenOf([pr({ review: "APPROVED" })]);
  assert.deepEqual(eventsOf(before, [pr({ review: "REVIEW_REQUIRED" })]), []);
});

test("red knocks, and the way back to green waits for the next waking", () => {
  assert.deepEqual(
    eventsOf(BASELINE(), [pr({ ci: "red" })]).map((e) => [e.kind, e.knock]),
    [["ci-red", true]],
  );
  const before = seenOf([pr({ ci: "red" })]);
  assert.deepEqual(
    eventsOf(before, [pr({ ci: "green" })]).map((e) => [e.kind, e.knock]),
    [["ci-green", false]],
  );
  // pending → red is still red; pending alone is not a change worth a word
  assert.deepEqual(eventsOf(BASELINE({ ci: "pending" }), [pr({ ci: "pending" })]), []);
});

test("merged and closed are reported once, and end the story for that pull request", () => {
  const merged = eventsOf(BASELINE(), [pr({ state: "MERGED", review: "APPROVED", ci: "none" })]);
  assert.deepEqual(merged.map((e) => [e.kind, e.knock]), [["merged", false]]);
  const closed = eventsOf(BASELINE(), [pr({ state: "CLOSED" })]);
  assert.deepEqual(closed.map((e) => [e.kind, e.knock]), [["closed", false]]);
  // a merged pull request whose review also changed is one message, not three
  assert.equal(merged.length, 1);
});

test("a draft is not looked at until it is ready", () => {
  assert.deepEqual(eventsOf(BASELINE({ draft: true }), [pr({ draft: true, review: "APPROVED" })]), []);
});

test("the text is facts and a link, and reads the same for a machine as for a person", () => {
  const [event] = eventsOf(BASELINE(), [pr({ review: "APPROVED" })]);
  assert.ok(event);
  const text = textOf(event);
  assert.match(text, /^PR #7 可以合了 · review APPROVED · ci 绿/);
  assert.match(text, /fix\(daemon\): something/);
  assert.match(text, /https:\/\/example\.invalid\/pull\/7/);
  assert.doesNotMatch(text, /建议|应该|记得/);
});

test("a knock lands in the inbox and a note lands in low, one file per state", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-feed-"));
  const paths = makePaths(root, "alice");
  const events = eventsOf(BASELINE(), [pr({ review: "APPROVED" })]);
  writeEvents(paths, events, new Date("2026-03-02T09:15:00Z"));

  const knockFile = join(paths.inbox, fileNameOf(events[0]!));
  const written = JSON.parse(readFileSync(knockFile, "utf8"));
  assert.equal(written.from, "github");
  assert.match(written.text, /PR #7 可以合了/);
  assert.equal(existsSync(paths.inboxLow) ? readdirSync(paths.inboxLow).length : 0, 0);

  // same pull request, a state that does not call: it waits instead of waking anything
  const quiet = eventsOf(seenOf([pr({ ci: "red" })]), [pr({ ci: "green" })]);
  writeEvents(paths, quiet);
  assert.equal(readdirSync(paths.inboxLow).length, 1);
  assert.equal(fileNameOf(quiet[0]!), "github-7-ci-green.json");
});

test("a pass that sees nothing does not erase what was known", () => {
  // an empty list is what a token that is not the account's own returns, every pass,
  // for as long as it runs. Overwriting would make that look exactly like a quiet world.
  const before = seenOf([pr({ review: "REVIEW_REQUIRED" })]);
  assert.deepEqual(mergeSeen(before, []), before);

  // a PR can also drop out of --limit and come back later; its baseline has to survive
  const merged = mergeSeen(seenOf([pr({ review: "REVIEW_REQUIRED" }), pr({ number: 8, review: "" })]), [
    pr({ review: "APPROVED" }),
  ]);
  assert.equal(Object.keys(merged).length, 2);
  assert.equal(merged["7"]?.review, "APPROVED");
  assert.equal(merged["8"]?.review, "");

  // and the transition nobody announced still shows up after the empty pass
  assert.equal(eventsOf(mergeSeen(before, []), [pr({ review: "APPROVED" })]).length, 1);
});
