const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { OpenCodeMonitor, partActivity } = require("../opencode-monitor.cjs");

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
});
