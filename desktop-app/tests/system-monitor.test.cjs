const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cpuPercent,
  memoryPercent,
} = require("../system-monitor.cjs");

test("calculates bounded CPU and memory utilization", () => {
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 75);
  assert.equal(memoryPercent(1000, 250), 75);
});
