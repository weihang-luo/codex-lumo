const test = require("node:test");
const assert = require("node:assert/strict");
const {
  eventSummary,
  labelForTool,
  parseJsonLines,
  shortTaskTitle,
  stripInjectedContext,
  taskSummaryFromEvents,
  thinkingStage,
} = require("../codex-monitor.cjs");

test("strips ambient browser context from task titles", () => {
  const source = `<in-app-browser-context source="ambient-ui-state">hidden</in-app-browser-context>
## My request for Codex:
封装成 Windows 悬浮应用`;
  assert.equal(stripInjectedContext(source), "封装成 Windows 悬浮应用");
  assert.equal(shortTaskTitle(source), "封装成 Windows 悬浮应用");
});

test("maps tool calls to privacy-safe activity labels", () => {
  assert.equal(labelForTool("shell_command"), "正在运行命令");
  assert.equal(labelForTool("apply_patch"), "正在修改文件");
  assert.equal(labelForTool("web__run"), "正在查找资料");
});

test("parses complete JSONL lines and ignores partial lines", () => {
  const input = `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n{"broken"`;
  const events = parseJsonLines(input);
  assert.equal(events.length, 1);
  assert.equal(eventSummary(events[0]), "收到新任务");
});

test("summarizes a running task from the latest turn", () => {
  const events = [
    { timestamp: "2026-07-21T03:00:00.000Z", payload: { type: "task_started" } },
    {
      timestamp: "2026-07-21T03:00:01.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "增强任务动效" }] },
    },
    {
      timestamp: "2026-07-21T03:00:02.000Z",
      payload: { type: "custom_tool_call", name: "wait" },
    },
  ];
  const task = taskSummaryFromEvents(events, { threadId: "thread-1", workspace: "C:\\work" });
  assert.equal(task.id, "thread-1");
  assert.equal(task.task, "增强任务动效");
  assert.equal(task.mode, "waiting");
  assert.equal(task.phase, "等待中");
});

test("excludes completed and aborted turns from running tasks", () => {
  const start = { timestamp: "2026-07-21T03:00:00.000Z", payload: { type: "task_started" } };
  const completed = { timestamp: "2026-07-21T03:00:02.000Z", payload: { type: "task_complete" } };
  const aborted = { timestamp: "2026-07-21T03:00:02.000Z", payload: { type: "turn_aborted" } };
  assert.equal(taskSummaryFromEvents([start, completed]), null);
  assert.equal(taskSummaryFromEvents([start, aborted]), null);
});

test("exposes rotating high-level thinking stages", () => {
  assert.equal(thinkingStage(0), "正在理解上下文");
  assert.equal(thinkingStage(3), "正在规划下一步");
  assert.equal(thinkingStage(4), "正在理解上下文");
});
