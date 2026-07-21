const test = require("node:test");
const assert = require("node:assert/strict");
const {
  eventSummary,
  labelForTool,
  parseJsonLines,
  shortTaskTitle,
  stripInjectedContext,
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
