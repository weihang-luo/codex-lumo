const test = require("node:test");
const assert = require("node:assert/strict");
const { extractOpenCodeInvocations, javascriptPromptVariables } = require("../codex-monitor.cjs");

function execCall(input, name = "exec_command") {
  return {
    timestamp: "2026-08-05T06:00:00.000Z",
    payload: {
      type: "custom_tool_call",
      name,
      call_id: "call-opencode",
      input,
    },
  };
}

test("captures const/let/var single-string JavaScript prompt variables", () => {
  const variables = javascriptPromptVariables(
    "let p = `Refactor the retry loop.`; var q = \"Rename tokens.\"; const r = 'Drop stale cache.';",
  );
  assert.equal(variables.get("p"), "Refactor the retry loop.");
  assert.equal(variables.get("q"), "Rename tokens.");
  assert.equal(variables.get("r"), "Drop stale cache.");
});

test("resolves const/let/var single-string prompts passed through JSON.stringify", () => {
  for (const keyword of ["const", "let", "var"]) {
    const input = keyword + " prompt = `Fix the mappingproxy serialization edge case.`;\n"
      + "const r = await tools.exec_command({cmd:`opencode run --model opencode/deepseek-v4-flash-free ${JSON.stringify(prompt)}`,"
      + 'workdir:"E:\\\\Project",tty:true}); text(r);';
    const [delegation] = extractOpenCodeInvocations(execCall(input));
    assert.ok(delegation, `expects a delegation for ${keyword}`);
    assert.equal(delegation.prompt, "Fix the mappingproxy serialization edge case.");
    assert.equal(delegation.title, "Fix the mappingproxy serialization edge case.");
    assert.ok(!delegation.title.includes("JSON.stringify"));
  }
});

test("expands array map launchers into parallel delegated prompts", () => {
  const input = "var jobs = [`Backfill missing indexes.`, `Normalize cached quota rows.`];\n"
    + "const r = await Promise.all(jobs.map((job)=>tools.exec_command({"
    + "cmd:`opencode run --model opencode/deepseek-v4-flash-free ${JSON.stringify(job)}`,"
    + 'workdir:"E:\\\\Project",tty:true}))); text(r);';
  const delegations = extractOpenCodeInvocations(execCall(input));
  assert.equal(delegations.length, 2);
  assert.deepEqual(delegations.map((item) => item.prompt), [
    "Backfill missing indexes.",
    "Normalize cached quota rows.",
  ]);
  assert.ok(delegations.every((item) => !item.title.includes("JSON.stringify")));
});

test("does not recognize example opencode run lines inside apply_patch strings", () => {
  const input = "const doc = `\n"
    + "*** Begin Patch\n"
    + "*** Update File: README.md\n"
    + "@@\n"
    + "+To launch a subagent from the terminal:\n"
    + "+opencode run --model opencode/deepseek-v4-flash-free --auto 'Explain this repo'\n"
    + "*** End Patch\n"
    + "`;\n"
    + "text(await tools.apply_patch(doc));";
  assert.deepEqual(extractOpenCodeInvocations(execCall(input, "apply_patch")), []);
});

test("does not treat plain shell text that mentions opencode run as a delegation", () => {
  const prose = execCall(
    'tools.shell_command({cmd:"echo Tip: invoke opencode run --model example from a terminal.",workdir:"E:\\\\Project"});',
    "shell_command",
  );
  assert.deepEqual(extractOpenCodeInvocations(prose), []);

  const docOnly = execCall(
    'tools.shell_command({cmd:"docs say: opencode run launches the CLI.",workdir:"E:\\\\Project"});',
    "shell_command",
  );
  assert.deepEqual(extractOpenCodeInvocations(docOnly), []);
});
