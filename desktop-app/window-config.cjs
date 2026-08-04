const WINDOW_SCALES = Object.freeze({
  small: 0.875,
  medium: 1,
  large: 1.16,
});

const DEFAULT_WINDOW_SIZE = "medium";
const DEFAULT_REVEAL_MS = 5000;
const MAX_VISIBLE_TASKS = 5;
const TASK_ROW_STEP = 88;
const DELEGATION_ROW_STEP = 38;
const TOP_DOCK_GAP = 12;
const REVEAL_OPTIONS = Object.freeze([0, 3000, 5000, 8000]);

function normalizeWindowSize(value) {
  return Object.hasOwn(WINDOW_SCALES, value) ? value : DEFAULT_WINDOW_SIZE;
}

function normalizeRevealMs(value) {
  const numeric = Number(value);
  return REVEAL_OPTIONS.includes(numeric) ? numeric : DEFAULT_REVEAL_MS;
}

function profileFor(value) {
  const name = normalizeWindowSize(value);
  const scale = WINDOW_SCALES[name];
  const readableSmall = name === "small";
  const compactWidth = Math.round(450 * scale);
  return {
    name,
    scale,
    contentScale: readableSmall ? 1 : scale,
    compact: {
      width: compactWidth,
      height: Math.round(66 * scale),
    },
    expandedWidth: compactWidth,
    settingsHeight: readableSmall ? 340 : Math.round(340 * scale),
  };
}

function expandedSize(value, taskCount = 1, view = "tasks", delegationRows = 0) {
  const profile = profileFor(value);
  if (view === "settings") {
    return { width: profile.expandedWidth, height: profile.settingsHeight };
  }
  const visibleRows = Math.max(1, Math.min(MAX_VISIBLE_TASKS, Number(taskCount) || 1));
  return {
    width: profile.expandedWidth,
    height: Math.round((202 + visibleRows * TASK_ROW_STEP + Math.max(0, Number(delegationRows) || 0) * DELEGATION_ROW_STEP) * profile.contentScale),
  };
}

module.exports = {
  DEFAULT_REVEAL_MS,
  DEFAULT_WINDOW_SIZE,
  DELEGATION_ROW_STEP,
  MAX_VISIBLE_TASKS,
  REVEAL_OPTIONS,
  TASK_ROW_STEP,
  TOP_DOCK_GAP,
  WINDOW_SCALES,
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
};
