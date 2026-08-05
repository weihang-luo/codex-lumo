const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasIrrecoverableText,
  repairMojibake,
  safeDisplayText,
  stripTerminalControls,
} = require("../text-quality.cjs");

test("repairs reversible GBK/UTF-8 mojibake found in historical Codex replies", () => {
  assert.equal(
    repairMojibake("娲诲姩璁板綍淇宸插畬鎴愶細"),
    "活动记录修正已完成：",
  );
});

test("suppresses irrecoverable replacement-character output from historical OpenCode tools", () => {
  const corrupted = "E:\\Data\\CondexProject\\����������\\TgtoDriveCompanion";
  assert.equal(hasIrrecoverableText(corrupted), true);
  assert.equal(safeDisplayText(corrupted, "命令输出编码异常"), "命令输出编码异常");
});

test("strips terminal control sequences before rendering", () => {
  assert.equal(stripTerminalControls("\u001b[31mFAILED\u001b[0m"), "FAILED");
});
