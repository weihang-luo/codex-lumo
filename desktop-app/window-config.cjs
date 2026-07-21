const WINDOW_SCALES = Object.freeze({
  small: 0.87,
  medium: 1,
  large: 1.16,
});

const DEFAULT_WINDOW_SIZE = "medium";
const DEFAULT_REVEAL_MS = 4200;
const REVEAL_OPTIONS = Object.freeze([3000, 5000, 8000]);

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
  return {
    name,
    scale,
    compact: {
      width: Math.round(420 * scale),
      height: Math.round(62 * scale),
    },
    expandedWidth: Math.round(520 * scale),
    settingsHeight: Math.round(320 * scale),
  };
}

function expandedSize(value, taskCount = 1, view = "tasks") {
  const profile = profileFor(value);
  if (view === "settings") {
    return { width: profile.expandedWidth, height: profile.settingsHeight };
  }
  const visibleRows = Math.max(1, Math.min(5, Number(taskCount) || 1));
  return {
    width: profile.expandedWidth,
    height: Math.round((210 + visibleRows * 44) * profile.scale),
  };
}

module.exports = {
  DEFAULT_REVEAL_MS,
  DEFAULT_WINDOW_SIZE,
  REVEAL_OPTIONS,
  WINDOW_SCALES,
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
};
