const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CodexMonitor,
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

test("lists every running session even when a task start is deep in a large log", (context) => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-monitor-"));
  const sessionsRoot = path.join(codexRoot, "sessions", "2026", "07", "21");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  context.after(() => fs.rmSync(codexRoot, { recursive: true, force: true }));

  const makeSession = (id, title, fillerBytes) => {
    const filePath = path.join(sessionsRoot, `rollout-2026-07-21T10-00-00-${id}.jsonl`);
    const started = { timestamp: new Date().toISOString(), payload: { type: "task_started" } };
    const message = { timestamp: new Date().toISOString(), payload: { type: "user_message", message: title } };
    fs.writeFileSync(filePath, `${JSON.stringify(started)}\n${JSON.stringify(message)}\n`, "utf8");
    if (fillerBytes) {
      const filler = { timestamp: new Date().toISOString(), payload: { type: "agent_reasoning", text: "x".repeat(fillerBytes) } };
      fs.appendFileSync(filePath, `${JSON.stringify(filler)}\n`, "utf8");
    }
    const tool = { timestamp: new Date().toISOString(), payload: { type: "custom_tool_call", name: "shell_command" } };
    fs.appendFileSync(filePath, `${JSON.stringify(tool)}\n`, "utf8");
    const stat = fs.statSync(filePath);
    return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
  };

  const candidates = [
    makeSession("019f8270-6c25-74a1-9f81-d9c85037ef11", "大型日志任务", 5 * 1024 * 1024),
    makeSession("019f8270-6c25-74a1-9f81-d9c85037ef12", "并行任务", 0),
  ];
  const monitor = new CodexMonitor({ codexRoot });
  const tasks = monitor.scanRunningTasks(candidates);

  assert.equal(tasks.length, 2);
  assert.deepEqual(new Set(tasks.map((task) => task.task)), new Set(["大型日志任务", "并行任务"]));
});
