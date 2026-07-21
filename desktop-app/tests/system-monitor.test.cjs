const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SystemMonitor,
  cpuPercent,
  memoryPercent,
} = require("../system-monitor.cjs");

test("calculates bounded CPU and memory utilization", () => {
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 75);
  assert.equal(memoryPercent(1000, 250), 75);
});

test("reduces telemetry sampling frequency in power-save mode", () => {
  const monitor = new SystemMonitor({ intervalMs: 2000, backgroundIntervalMs: 15000 });
  assert.equal(monitor.setPowerSave(true), 15000);
  assert.equal(monitor.setPowerSave(false), 2000);
  monitor.stop();
});
