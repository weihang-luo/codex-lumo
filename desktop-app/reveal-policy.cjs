const PROGRESS_MODES = new Set(["working", "waiting", "done", "error"]);

function progressRevealSignal(state) {
  const mode = String(state?.mode || "");
  if (!PROGRESS_MODES.has(mode)) return "";

  const primaryTask = Array.isArray(state?.tasks) ? state.tasks[0] : null;
  const taskId = state?.threadId || primaryTask?.id || "active";
  const startedAt = state?.startedAt || primaryTask?.startedAt || 0;
  return `${taskId}|${startedAt}|${mode}`;
}

class ProgressRevealPolicy {
  constructor(limit = 64) {
    this.limit = limit;
    this.seen = new Set();
  }

  shouldReveal(state) {
    const signal = progressRevealSignal(state);
    if (!signal || this.seen.has(signal)) return false;

    this.seen.add(signal);
    while (this.seen.size > this.limit) {
      this.seen.delete(this.seen.values().next().value);
    }
    return true;
  }
}

module.exports = { ProgressRevealPolicy, progressRevealSignal };
