const test = require("node:test");
const assert = require("node:assert/strict");
const { ProgressRevealPolicy, progressRevealSignal } = require("../reveal-policy.cjs");

test("thinking and idle states never request a reveal", () => {
  assert.equal(progressRevealSignal({ mode: "thinking", threadId: "one" }), "");
  assert.equal(progressRevealSignal({ mode: "resting" }), "");
  assert.equal(progressRevealSignal({ mode: "offline" }), "");
});

test("real progress reveals once per task stage", () => {
  const policy = new ProgressRevealPolicy();
  const working = { mode: "working", threadId: "one", startedAt: 100 };

  assert.equal(policy.shouldReveal({ mode: "thinking", threadId: "one", startedAt: 100 }), false);
  assert.equal(policy.shouldReveal(working), true);
  assert.equal(policy.shouldReveal({ ...working, phase: "Running command", detail: "step 2" }), false);
  assert.equal(policy.shouldReveal({ mode: "thinking", threadId: "one", startedAt: 100 }), false);
  assert.equal(policy.shouldReveal(working), false);
  assert.equal(policy.shouldReveal({ ...working, mode: "waiting" }), true);
  assert.equal(policy.shouldReveal({ ...working, mode: "done" }), true);
  assert.equal(policy.shouldReveal({ ...working, mode: "error" }), true);
});

test("a new task can reveal the same progress stage", () => {
  const policy = new ProgressRevealPolicy();
  assert.equal(policy.shouldReveal({ mode: "working", threadId: "one", startedAt: 100 }), true);
  assert.equal(policy.shouldReveal({ mode: "working", threadId: "two", startedAt: 100 }), true);
  assert.equal(policy.shouldReveal({ mode: "working", threadId: "one", startedAt: 200 }), true);
});

test("task-list identity is used when the aggregate state has no thread id", () => {
  assert.equal(
    progressRevealSignal({ mode: "working", tasks: [{ id: "task-a", startedAt: 42 }] }),
    "task-a|42|working",
  );
});
