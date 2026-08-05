const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  advanceDelegations,
  alignTaskWithDelegations,
  CodexMonitor,
  eventSummary,
  extractOpenCodeInvocations,
  labelForTool,
  parseJsonLines,
  quotaFromRateLimits,
  quotaFromRateLimitRecords,
  shortTaskTitle,
  stripInjectedContext,
  taskSummaryFromEvents,
  thinkingStage,
} = require("../codex-monitor.cjs");

function openCodeCall(callId = "call-opencode") {
  const command = `$taskPrompt = @'
Implement the bounded parser fix and report changed files.
'@; opencode run --model opencode/deepseek-v4-flash-free --auto $taskPrompt`;
  return {
    timestamp: "2026-08-04T05:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: JSON.stringify({ command, workdir: "E:\\Project" }),
    },
  };
}

test("extracts OpenCode delegation metadata only from executable command fields", () => {
  const [delegation] = extractOpenCodeInvocations(openCodeCall());
  assert.equal(delegation.model, "opencode/deepseek-v4-flash-free");
  assert.equal(delegation.directory, "E:\\Project");
  assert.match(delegation.title, /bounded parser fix/i);
  assert.equal(delegation.status, "running");

  const patchText = {
    payload: { type: "custom_tool_call", name: "apply_patch", input: "Document opencode run --model example" },
  };
  assert.deepEqual(extractOpenCodeInvocations(patchText), []);
});

test("tracks OpenCode transport sessions and explicit completion", () => {
  const task = { delegations: [], lastEventAt: 0 };
  advanceDelegations(task, openCodeCall("call-start"));
  advanceDelegations(task, {
    timestamp: "2026-08-04T05:00:01.000Z",
    payload: { type: "function_call_output", call_id: "call-start", output: "Script running with cell ID cell-42" },
  });
  assert.equal(task.delegations[0].transportId, "cell-42");
  assert.equal(task.delegations[0].status, "running");

  advanceDelegations(task, {
    timestamp: "2026-08-04T05:00:02.000Z",
    payload: { type: "function_call", call_id: "call-wait", arguments: JSON.stringify({ cell_id: "cell-42" }) },
  });
  advanceDelegations(task, {
    timestamp: "2026-08-04T05:00:03.000Z",
    payload: { type: "function_call_output", call_id: "call-wait", output: "Process exited with code 0" },
  });
  assert.equal(task.delegations[0].status, "completed");
  assert.equal(task.delegations[0].completedAt, Date.parse("2026-08-04T05:00:03.000Z"));
});

test("a running OpenCode child keeps its parent in an accurate execution state", () => {
  const task = alignTaskWithDelegations({
    mode: "error",
    phase: "调整中",
    detail: "Earlier command failed",
    delegations: [{ status: "running", latestUpdate: "正在执行 bash", lastEventAt: 20 }],
  });
  assert.equal(task.mode, "working");
  assert.equal(task.phase, "执行中");
  assert.equal(task.detail, "OpenCode · 正在执行 bash");
});

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

test("distinguishes visible agent replies from reasoning summaries", () => {
  const visibleReply = {
    timestamp: "2026-07-21T09:00:00.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "正在核对事件字段" },
  };
  const reasoning = {
    timestamp: "2026-07-21T09:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "Adjusting reply reveal policy" },
  };

  assert.equal(eventSummary(visibleReply), "Codex 发来回复");
  assert.equal(eventSummary(reasoning), "分析任务");

  const monitor = new CodexMonitor();
  monitor.state.threadId = "thread-1";
  monitor.state.startedAt = Date.parse("2026-07-21T08:59:00.000Z");
  monitor.consume(visibleReply);
  assert.equal(monitor.state.mode, "reply");
  assert.equal(monitor.state.detail, "正在核对事件字段");
  assert.equal(monitor.state.replyFresh, true);
  const replyAt = monitor.state.replyAt;

  monitor.consume(reasoning, true);
  assert.equal(monitor.state.mode, "thinking");
  assert.equal(monitor.state.replyAt, replyAt);
  assert.equal(monitor.state.replyFresh, false);
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
      payload: { type: "agent_message", message: "正在调整机器人动作和任务状态展示" },
    },
    {
      timestamp: "2026-07-21T03:00:03.000Z",
      payload: { type: "custom_tool_call", name: "wait" },
    },
  ];
  const task = taskSummaryFromEvents(events, { threadId: "thread-1", workspace: "C:\\work" });
  assert.equal(task.id, "thread-1");
  assert.equal(task.task, "增强任务动效");
  assert.equal(task.mode, "waiting");
  assert.equal(task.phase, "等待中");
  assert.equal(task.detail, "等待后台任务");
  assert.equal(task.latestReply, "正在调整机器人动作和任务状态展示");
  assert.equal(task.replyAt, Date.parse("2026-07-21T03:00:02.000Z"));
});

test("excludes completed and aborted turns from running tasks", () => {
  const start = { timestamp: "2026-07-21T03:00:00.000Z", payload: { type: "task_started" } };
  const completed = { timestamp: "2026-07-21T03:00:02.000Z", payload: { type: "task_complete" } };
  const aborted = { timestamp: "2026-07-21T03:00:02.000Z", payload: { type: "turn_aborted" } };
  assert.equal(taskSummaryFromEvents([start, completed]), null);
  assert.equal(taskSummaryFromEvents([start, aborted]), null);
});

test("does not revive an old completion after the task list becomes idle", () => {
  const monitor = new CodexMonitor();
  let queried = false;
  monitor.db = {
    prepare() {
      queried = true;
      return { all: () => [] };
    },
  };
  monitor.state.threadId = "thread-1";
  monitor.state.startedAt = Date.now() - 60000;
  monitor.state.mode = "resting";
  monitor.state.phase = "待机中";
  monitor.state.tasks = [];

  monitor.checkCompletionFromLogs();

  assert.equal(queried, false);
  assert.equal(monitor.state.mode, "resting");
  assert.equal(monitor.state.phase, "待机中");
});

test("deduplicates unchanged state snapshots and supports background polling", () => {
  const monitor = new CodexMonitor({
    pollIntervalMs: 700,
    rescanIntervalMs: 2800,
    backgroundPollMs: 2000,
    backgroundRescanMs: 10000,
  });
  let emitted = 0;
  monitor.on("state", () => { emitted += 1; });

  assert.equal(monitor.emitState(), true);
  assert.equal(monitor.emitState(), false);
  assert.equal(emitted, 1);
  assert.equal(monitor.setPowerSave(true), true);
  assert.equal(monitor.powerSaving, true);
  assert.equal(monitor.setPowerSave(false), false);
  monitor.stop();
});

test("exposes rotating high-level thinking stages", () => {
  assert.equal(thinkingStage(0), "正在理解上下文");
  assert.equal(thinkingStage(3), "正在规划下一步");
  assert.equal(thinkingStage(4), "正在理解上下文");
});

test("uses the most constrained real Codex quota window", () => {
  const quota = quotaFromRateLimits({
    limit_id: "codex",
    plan_type: "pro",
    primary: { used_percent: 28, window_minutes: 10080, resets_at: 1785203040 },
    secondary: { used_percent: 65, window_minutes: 300, resets_at: 1784620000 },
    credits: { has_credits: false, unlimited: false, balance: "0" },
  });

  assert.equal(quota.available, true);
  assert.equal(quota.kind, "secondary");
  assert.equal(quota.remainingPercent, 35);
  assert.equal(quota.windowMinutes, 300);
  assert.equal(quota.limitName, "Codex");
});

test("keeps quota stable across task logs with different limit pools", () => {
  const now = Date.parse("2026-07-21T09:00:00.000Z");
  const reset = Math.floor(now / 1000) + 86400;
  const quota = quotaFromRateLimitRecords([
    {
      observedAt: now - 1000,
      rateLimits: {
        limit_id: "codex",
        primary: { used_percent: 52, window_minutes: 10080, resets_at: reset },
      },
    },
    {
      observedAt: now,
      rateLimits: {
        limit_id: "codex_bengalfox",
        limit_name: "GPT-5.3-Codex-Spark",
        primary: { used_percent: 0, window_minutes: 10080, resets_at: reset },
      },
    },
  ], now);

  assert.equal(quota.limitId, "codex");
  assert.equal(quota.remainingPercent, 48);
});

test("uses only the newest event for each quota pool", () => {
  const now = Date.parse("2026-07-21T09:00:00.000Z");
  const reset = Math.floor(now / 1000) + 86400;
  const quota = quotaFromRateLimitRecords([
    { observedAt: now - 2000, rateLimits: { limit_id: "codex", primary: { used_percent: 90, resets_at: reset } } },
    { observedAt: now - 1000, rateLimits: { limit_id: "codex", primary: { used_percent: 52, resets_at: reset } } },
  ], now);

  assert.equal(quota.remainingPercent, 48);
});

test("ignores quota windows whose reset time has passed", () => {
  const now = Date.parse("2026-07-21T09:00:00.000Z");
  const quota = quotaFromRateLimitRecords([
    {
      observedAt: now - 10000,
      rateLimits: { limit_id: "codex", primary: { used_percent: 95, resets_at: Math.floor((now - 1000) / 1000) } },
    },
    {
      observedAt: now - 500,
      rateLimits: { limit_id: "codex_bengalfox", primary: { used_percent: 10, resets_at: Math.floor((now + 86400000) / 1000) } },
    },
  ], now);

  assert.equal(quota.limitId, "codex_bengalfox");
  assert.equal(quota.remainingPercent, 90);
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

test("drops abandoned start-only sessions instead of counting phantom parent tasks", (context) => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-start-only-"));
  const sessionsRoot = path.join(codexRoot, "sessions", "2026", "08", "04");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  context.after(() => fs.rmSync(codexRoot, { recursive: true, force: true }));
  const filePath = path.join(
    sessionsRoot,
    "rollout-2026-08-04T02-00-00-019f8270-6c25-74a1-9f81-d9c85037ef13.jsonl",
  );
  const oldStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(filePath, `${JSON.stringify({ timestamp: oldStart, payload: { type: "task_started" } })}\n`, "utf8");
  const stat = fs.statSync(filePath);
  const monitor = new CodexMonitor({ codexRoot });
  const tasks = monitor.scanRunningTasks([{ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }]);
  assert.equal(tasks.length, 0);
});
