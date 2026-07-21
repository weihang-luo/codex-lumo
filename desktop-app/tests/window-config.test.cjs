const test = require("node:test");
const assert = require("node:assert/strict");
const {
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
} = require("../window-config.cjs");

test("normalizes persisted window settings", () => {
  assert.equal(normalizeWindowSize("small"), "small");
  assert.equal(normalizeWindowSize("unknown"), "medium");
  assert.equal(normalizeRevealMs(5000), 5000);
  assert.equal(normalizeRevealMs(1234), 4200);
});

test("provides proportional compact window profiles", () => {
  assert.deepEqual(profileFor("small").compact, { width: 365, height: 54 });
  assert.deepEqual(profileFor("medium").compact, { width: 420, height: 62 });
  assert.deepEqual(profileFor("large").compact, { width: 487, height: 72 });
});

test("sizes task and settings views independently", () => {
  assert.deepEqual(expandedSize("medium", 3, "tasks"), { width: 520, height: 342 });
  assert.deepEqual(expandedSize("medium", 3, "settings"), { width: 520, height: 320 });
});
