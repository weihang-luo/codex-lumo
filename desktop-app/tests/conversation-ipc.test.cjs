const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { CodexMonitor } = require("../codex-monitor.cjs");

function createConversationDb(root) {
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
  const t0 = Date.parse("2026-08-05T02:00:00.000Z");
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "ses_ui", "Filter repair", "E:/Project", JSON.stringify({ id: "deepseek-v4-flash-free" }),
    t0, t0 + 30000, 500, 120, 60, 0,
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_1", "ses_ui", t0, t0, JSON.stringify({ role: "user", time: { created: t0 } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_1", "msg_1", "ses_ui", t0, t0,
    JSON.stringify({ type: "text", text: "Implement the global filter fix and report changed files." }),
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    "msg_2", "ses_ui", t0 + 1000, t0 + 1000, JSON.stringify({ role: "assistant", time: { created: t0 + 1000 } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_2", "msg_2", "ses_ui", t0 + 2000, t0 + 2000,
    JSON.stringify({ type: "reasoning", text: "Check how filters are composed across pages" }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_3", "msg_2", "ses_ui", t0 + 3000, t0 + 3000,
    JSON.stringify({ type: "tool", tool: "bash", state: { title: "npm run test" } }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    "part_4", "msg_2", "ses_ui", t0 + 4000, t0 + 4000,
    JSON.stringify({ type: "text", text: "Filter now persists across pages." }),
  );
  db.close();
  return dbPath;
}

function makeMonitor(root) {
  const monitor = new CodexMonitor({ openCodeDbPath: createConversationDb(root) });
  return monitor;
}

function registerCleanup(context, monitor, root) {
  context.after(() => {
    monitor.openCode.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("IPC-bound monitor returns a chronological read-only conversation for a running session", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-conversation-"));
  const monitor = makeMonitor(root);
  registerCleanup(context, monitor, root);

  const conversation = monitor.getOpenCodeConversation("ses_ui");
  assert.equal(conversation.available, true);
  assert.equal(conversation.title, "Filter repair");
  assert.equal(conversation.status, "running");
  assert.equal(conversation.stage, "reply");
  assert.deepEqual(conversation.entries.map((entry) => entry.label), [
    "任务",
    "分析",
    "工具 · bash",
    "回复",
  ]);
  assert.deepEqual(conversation.entries.map((entry) => entry.type), [
    "message",
    "reasoning",
    "tool",
    "message",
  ]);
  assert.equal(conversation.entries[0].text, "Implement the global filter fix and report changed files.");
  assert.equal(conversation.entries[1].text, "Check how filters are composed across pages");
  assert.equal(conversation.entries[2].text, "npm run test");
  assert.ok(conversation.entries.every((entry) => Number(entry.timestamp) > 0));
});

test("a terminal delegation overrides the session status for the running task list", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-conversation-"));
  const monitor = makeMonitor(root);
  registerCleanup(context, monitor, root);

  const completedAt = Date.parse("2026-08-05T02:05:00.000Z");
  monitor.runningTasks = [{
    id: "codex-parent",
    delegations: [{
      sessionId: "ses_ui",
      status: "failed",
      stage: "failed",
      completedAt,
      lastEventAt: completedAt,
    }],
  }];

  const conversation = monitor.getOpenCodeConversation("ses_ui");
  assert.equal(conversation.status, "failed");
  assert.equal(conversation.stage, "failed");
  assert.equal(conversation.completedAt, completedAt);

  const unknown = monitor.getOpenCodeConversation("ses_missing");
  assert.equal(unknown.available, false);
  assert.equal(unknown.entries.length, 0);
});
