const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  advanceDelegations,
  extractOpenCodeInvocations,
  hasOpenCodeLaunchHint,
} = require("../codex-monitor.cjs");
const { OpenCodeMonitor } = require("../opencode-monitor.cjs");

function dynamicLaunchEvent(timestamp = "2026-08-05T04:00:00.000Z") {
  return {
    timestamp,
    payload: {
      type: "custom_tool_call",
      call_id: "call_parallel",
      input: [
        "const tasks = [",
        "  { cmd: 'opencode run -m opencode/deepseek-v4-flash-free --auto \\\"repair monitor filters\\\"' },",
        "  { cmd: 'opencode run --agent build --dir E:/Project/App \\\"add subtitle metadata\\\"' },",
        "];",
        "const rs = await Promise.all(tasks.map(t => tools.exec_command({cmd:t.cmd, workdir:'E:/Project'})));",
      ].join("\n"),
    },
  };
}

test("recognizes object-array dynamic launchers and maps parallel transport ids", () => {
  const launch = dynamicLaunchEvent();
  assert.equal(hasOpenCodeLaunchHint(launch), true);
  const invocations = extractOpenCodeInvocations(launch);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map((item) => item.prompt), ["repair monitor filters", "add subtitle metadata"]);
  assert.equal(invocations[1].directory, "E:/Project/App");

  const task = { workspace: "E:/Project", delegations: [], lastEventAt: Date.parse(launch.timestamp) };
  advanceDelegations(task, launch);
  advanceDelegations(task, {
    timestamp: "2026-08-05T04:00:01.000Z",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call_parallel",
      output: "Script running with cell ID 111\nScript running with cell ID 222",
    },
  });
  assert.deepEqual(task.delegations.map((item) => item.transportId), ["111", "222"]);
});

function createDatabase(root, sessions) {
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
  for (const session of sessions) {
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      session.id, session.title, session.directory, JSON.stringify({ id: "deepseek-v4-flash-free" }),
      session.createdAt, session.createdAt + 100, 10, 20, 0, 0,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      `msg_${session.id}`, session.id, session.createdAt + 1, session.createdAt + 1,
      JSON.stringify({ role: "user", time: { created: session.createdAt + 1 } }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      `part_${session.id}`, `msg_${session.id}`, session.id, session.createdAt + 2, session.createdAt + 2,
      JSON.stringify({ type: "text", text: session.title }),
    );
  }
  db.close();
  return dbPath;
}

test("discovers nested sessions, assigns the nearest parent task, and avoids duplicates", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumo-discovery-"));
  const base = Date.parse("2026-08-05T04:00:00.000Z");
  const dbPath = createDatabase(root, [
    { id: "ses_nested", title: "Nested worker", directory: "E:/Project/App", createdAt: base + 1100 },
    { id: "ses_linked", title: "Linked worker", directory: "E:/Project/App", createdAt: base + 1200 },
    { id: "ses_other", title: "Other worker", directory: "E:/Unrelated", createdAt: base + 1300 },
  ]);
  const monitor = new OpenCodeMonitor({ dbPath });
  context.after(() => {
    monitor.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const tasks = monitor.enrichTasks([
    {
      id: "older",
      workspace: "E:/Project",
      startedAt: base - 5000,
      openCodeHintAt: base,
      delegations: [],
    },
    {
      id: "newer",
      workspace: "E:/Project",
      startedAt: base + 500,
      openCodeHintAt: base + 1000,
      delegations: [{
        id: "known",
        sessionId: "ses_linked",
        prompt: "Linked worker",
        directory: "E:/Project/App",
        startedAt: base + 1200,
        status: "running",
      }],
    },
  ]);
  assert.equal(tasks[0].delegations.length, 0);
  assert.deepEqual(
    tasks[1].delegations.map((item) => item.sessionId).sort(),
    ["ses_linked", "ses_nested"],
  );
  assert.equal(tasks[1].delegations.filter((item) => item.sessionId === "ses_linked").length, 1);
  assert.ok(!tasks.flatMap((task) => task.delegations).some((item) => item.sessionId === "ses_other"));
});
