const test = require("node:test");
const assert = require("node:assert/strict");
const { ProgressRevealPolicy, progressRevealSignal } = require("../reveal-policy.cjs");

test("only a newly arrived visible reply can request a reveal", () => {
  assert.equal(progressRevealSignal({ mode: "thinking", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "working", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "waiting", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "error", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "done", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "reply", threadId: "one", replyAt: 1, replyFresh: false }), "");
  assert.equal(progressRevealSignal({ mode: "resting" }), "");
  assert.equal(progressRevealSignal({ mode: "offline" }), "");
});

test("a visible reply reveals only once", () => {
  const policy = new ProgressRevealPolicy();
  const reply = { mode: "reply", threadId: "one", replyAt: 100, replyFresh: true };

  assert.equal(policy.shouldReveal({ mode: "thinking", threadId: "one" }), false);
  assert.equal(policy.shouldReveal({ ...reply, mode: "working" }), false);
  assert.equal(policy.shouldReveal({ ...reply, mode: "waiting" }), false);
  assert.equal(policy.shouldReveal(reply), true);
  assert.equal(policy.shouldReveal({ ...reply, phase: "有新回复", detail: "刷新文案" }), false);
});

test("each newly arrived reply can reveal", () => {
  const policy = new ProgressRevealPolicy();
  assert.equal(policy.shouldReveal({ mode: "reply", threadId: "one", replyAt: 100, replyFresh: true }), true);
  assert.equal(policy.shouldReveal({ mode: "reply", threadId: "two", replyAt: 100, replyFresh: true }), true);
  assert.equal(policy.shouldReveal({ mode: "reply", threadId: "one", replyAt: 200, replyFresh: true }), true);
});

test("task-list identity is used when the aggregate state has no thread id", () => {
  assert.equal(
    progressRevealSignal({ mode: "reply", replyAt: 42, replyFresh: true, tasks: [{ id: "task-a" }] }),
    "task-a|42|reply",
  );
});
