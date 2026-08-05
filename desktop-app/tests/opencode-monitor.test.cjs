const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { OpenCodeMonitor, partActivity, scoreSession } = require("../opencode-monitor.cjs");

test("maps OpenCode part types to readable live stages", () => {
  assert.deepEqual(partActivity({ type: "reasoning", text: "Checking parser branches" }), {
    stage: "thinking",
    latestUpdate: "Checking parser branches",
  });
  assert.deepEqual(partActivity({ type: "tool", tool: "bash", state: { title: "Run tests" } }), {
    stage: "tool",
    latestUpdate: "正在执行 bash · Run tests",
  });
});

test("matches prompts even when a Windows launcher preserves escaped newlines and split quotes", () => {
  const expected = "你是前后端 worker。只处理“订阅全局筛选”：\n1) 修改 API。";
  const launched = "\"你是前后端 worker。只处理\" \"订阅全局筛选：\\n1) 修改 API。\"";
  assert.equal(
    require("../opencode-monitor.cjs").comparableText(expected),
    require("../opencode-monitor.cjs").comparableText(launched),
  );
  assert.ok(scoreSession(
    { prompt: expected, directory: "E:\\Project", startedAt: 1000 },
    { directory: "E:/Project", time_created: 1200, time_updated: 1200 },
    [{ data: JSON.stringify({ type: "text", text: launched }) }],
  ) >= 90);
});

test("matches and enriches a delegated task from read-only OpenCode tables", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-opencode-"));
  const dbPath = path.join(root, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, cost REAL
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const startedAt = Date.parse("2026-08-04T05:00:00.000Z");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_test", "Parser repair", "E:/Project", JSON.stringify({ id: "deepseek-v4-flash-free" }),
    startedAt + 50, startedAt + 4000, 1200, 280, 90, 0,
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_user", "ses_test", startedAt + 100, startedAt + 100,
    JSON.stringify({ role: "user", time: { created: startedAt + 100 } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_user", "msg_user", "ses_test", startedAt + 110, startedAt + 110,
    JSON.stringify({ type: "text", text: "Implement the bounded parser fix and report changed files." }),
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_assistant", "ses_test", startedAt + 200, startedAt + 4000,
    JSON.stringify({ role: "assistant", time: { created: startedAt + 200 } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_reasoning", "msg_assistant", "ses_test", startedAt + 3000, startedAt + 4000,
    JSON.stringify({ type: "reasoning", text: "Checking the failing parser branch" }),
  );
  db.close();

  const monitor = new OpenCodeMonitor({ dbPath });
  context.after(() => {
    monitor.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [task] = monitor.enrichTasks([{
    id: "codex-parent",
    delegations: [{
      id: "call:0",
      prompt: "Implement the bounded parser fix and report changed files.",
      directory: "E:\\Project",
      startedAt,
      status: "running",
    }],
  }]);
  const delegation = task.delegations[0];
  assert.equal(delegation.sessionId, "ses_test");
  assert.equal(delegation.stage, "thinking");
  assert.equal(delegation.status, "running");
  assert.equal(delegation.latestUpdate, "Checking the failing parser branch");
  assert.equal(delegation.tokens.output, 280);
  assert.equal(delegation.model, "deepseek-v4-flash-free");

  const conversation = monitor.getConversation("ses_test");
  assert.equal(conversation.available, true);
  assert.equal(conversation.title, "Parser repair");
  assert.deepEqual(conversation.entries.map((entry) => entry.label), ["任务", "分析"]);
  assert.equal(conversation.entries[0].text, "Implement the bounded parser fix and report changed files.");
  assert.deepEqual(monitor.getConversation("../secrets"), {
    available: false,
    sessionId: "../secrets",
    entries: [],
    error: "OpenCode 会话不可用",
  });

  const writer = new DatabaseSync(dbPath);
  writer.prepare("UPDATE message SET data = ? WHERE id = ?").run(
    JSON.stringify({ role: "assistant", time: { created: startedAt + 200, completed: startedAt + 4200 }, finish: "stop" }),
    "msg_assistant",
  );
  writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_assistant_next", "ses_test", startedAt + 5000, startedAt + 5000,
    JSON.stringify({ role: "assistant", time: { created: startedAt + 5000 } }),
  );
  writer.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(startedAt + 5000, "ses_test");
  writer.close();

  const nextTurn = monitor.sessionState("ses_test");
  assert.equal(nextTurn.status, "running");
  assert.equal(nextTurn.stage, "working");
  assert.equal(nextTurn.completedAt, 0);
  assert.equal(nextTurn.latestUpdate, "OpenCode 正在处理");

  const finalWriter = new DatabaseSync(dbPath);
  finalWriter.prepare("UPDATE message SET time_updated = ?, data = ? WHERE id = ?").run(
    startedAt + 7000,
    JSON.stringify({ role: "assistant", time: { created: startedAt + 5000, completed: startedAt + 7000 }, finish: "stop" }),
    "msg_assistant_next",
  );
  finalWriter.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_tool", "msg_assistant_next", "ses_test", startedAt + 6000, startedAt + 6500,
    JSON.stringify({ type: "tool", tool: "bash", state: { title: "npm run build" } }),
  );
  finalWriter.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(startedAt + 7000, "ses_test");
  finalWriter.close();

  const completedTurn = monitor.sessionState("ses_test");
  assert.equal(completedTurn.status, "completed");
  assert.equal(completedTurn.stage, "completed");
  assert.equal(completedTurn.latestUpdate, "OpenCode 已完成");

  const [terminalTask] = monitor.enrichTasks([{
    id: "codex-parent",
    delegations: [{
      id: "call:0",
      prompt: "Implement the bounded parser fix and report changed files.",
      directory: "E:\\Project",
      startedAt,
      status: "failed",
      completedAt: startedAt + 8000,
      lastEventAt: startedAt + 8000,
    }],
  }]);
  assert.equal(terminalTask.delegations[0].status, "failed");
  assert.equal(terminalTask.delegations[0].latestUpdate, "OpenCode 子任务已中断");
});
