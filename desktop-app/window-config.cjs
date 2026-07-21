const WINDOW_SCALES = Object.freeze({
  small: 0.875,
  medium: 1,
  large: 1.16,
});

const DEFAULT_WINDOW_SIZE = "medium";
const DEFAULT_REVEAL_MS = 5000;
const MAX_VISIBLE_TASKS = 5;
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
  return {
    name,
    scale,
    contentScale: readableSmall ? 1 : scale,
    compact: {
      width: Math.round(450 * scale),
      height: Math.round(66 * scale),
    },
    expandedWidth: readableSmall ? 500 : Math.round(550 * scale),
    settingsHeight: readableSmall ? 340 : Math.round(340 * scale),
  };
}

function expandedSize(value, taskCount = 1, view = "tasks") {
  const profile = profileFor(value);
  if (view === "settings") {
    return { width: profile.expandedWidth, height: profile.settingsHeight };
  }
  const visibleRows = Math.max(1, Math.min(MAX_VISIBLE_TASKS, Number(taskCount) || 1));
  return {
    width: profile.expandedWidth,
    height: Math.round((270 + visibleRows * 46) * profile.contentScale),
  };
}

module.exports = {
  DEFAULT_REVEAL_MS,
  DEFAULT_WINDOW_SIZE,
  MAX_VISIBLE_TASKS,
  REVEAL_OPTIONS,
  WINDOW_SCALES,
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
};
