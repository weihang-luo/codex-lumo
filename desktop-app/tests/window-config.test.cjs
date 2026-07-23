const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOP_DOCK_GAP,
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
} = require("../window-config.cjs");

test("keeps a compact breathing gap below the top edge while docked", () => {
  assert.equal(TOP_DOCK_GAP, 12);
});

test("normalizes persisted window settings", () => {
  assert.equal(normalizeWindowSize("small"), "small");
  assert.equal(normalizeWindowSize("unknown"), "medium");
  assert.equal(normalizeRevealMs(5000), 5000);
  assert.equal(normalizeRevealMs(0), 0);
  assert.equal(normalizeRevealMs(1234), 5000);
});

test("provides proportional compact window profiles", () => {
  assert.deepEqual(profileFor("small").compact, { width: 394, height: 58 });
  assert.deepEqual(profileFor("medium").compact, { width: 450, height: 66 });
  assert.deepEqual(profileFor("large").compact, { width: 522, height: 77 });
});

test("sizes task and settings views independently", () => {
  assert.deepEqual(expandedSize("medium", 3, "tasks"), { width: 450, height: 466 });
  assert.deepEqual(expandedSize("medium", 3, "settings"), { width: 450, height: 340 });
  assert.deepEqual(expandedSize("small", 1, "tasks"), { width: 394, height: 290 });
  assert.deepEqual(expandedSize("small", 1, "settings"), { width: 394, height: 340 });
});

test("shows five task rows before the detail list needs scrolling", () => {
  assert.deepEqual(expandedSize("medium", 5, "tasks"), { width: 450, height: 642 });
  assert.deepEqual(expandedSize("medium", 8, "tasks"), { width: 450, height: 642 });
});
