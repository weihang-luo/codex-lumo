const island = document.getElementById("island");
const expandButton = document.getElementById("expandButton");
const progressButton = document.getElementById("progressButton");
const hideButton = document.getElementById("hideButton");
const passButton = document.getElementById("passButton");
const logsButton = document.getElementById("logsButton");
const quitButton = document.getElementById("quitButton");

let expanded = false;
let latestState = null;
let lastMode = "";
let lastProgress = -1;
let lastTaskSignature = "";
let renderedTaskCount = 1;

const elements = {
  connection: document.getElementById("connection"),
  phase: document.getElementById("phase"),
  detail: document.getElementById("detail"),
  elapsed: document.getElementById("elapsed"),
  progress: document.getElementById("progress"),
  taskCount: document.getElementById("taskCount"),
  taskList: document.getElementById("taskList"),
  workspace: document.getElementById("workspace"),
  events: document.getElementById("events"),
};

function formatTime(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function compactPath(value = "") {
  if (!value) return "CODEX HOME";
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" / ").toUpperCase();
}

function eventTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000));
  if (seconds < 4) return "NOW";
  if (seconds < 60) return `${seconds}S`;
  return `${Math.floor(seconds / 60)}M`;
}

function renderEvents(events = []) {
  elements.events.replaceChildren();
  const source = events.length ? events.slice(0, 3) : [{ label: "等待 Codex 事件", timestamp: Date.now() }];
  source.forEach((event) => {
    const item = document.createElement("li");
    const dot = document.createElement("i");
    const label = document.createElement("span");
    const time = document.createElement("time");
    label.textContent = event.label;
    time.textContent = eventTime(event.timestamp);
    item.append(dot, label, time);
    elements.events.append(item);
  });
}

function currentTasks(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  if (tasks.length) return tasks;
  if (["thinking", "working", "waiting", "error"].includes(state?.mode)) {
    return [{
      id: state.threadId,
      task: state.task,
      mode: state.mode,
      phase: state.phase,
      detail: state.detail,
      progress: state.progress,
      startedAt: state.startedAt,
      workspace: state.workspace,
    }];
  }
  return [];
}

function renderTasks(state) {
  const tasks = currentTasks(state);
  const signature = tasks
    .map((task) => [task.id, task.task, task.mode, task.phase, task.detail, task.progress].join("~"))
    .join("|");
  const nextCount = Math.max(1, tasks.length);
  elements.taskCount.textContent = String(tasks.length);

  if (expanded && nextCount !== renderedTaskCount) {
    window.lumo.resize(true, nextCount);
  }
  renderedTaskCount = nextCount;
  if (signature === lastTaskSignature) return;
  lastTaskSignature = signature;
  elements.taskList.replaceChildren();

  if (!tasks.length) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.innerHTML = "<span>暂无正在运行的任务</span><b>STANDBY</b>";
    elements.taskList.append(empty);
    return;
  }

  tasks.forEach((task, index) => {
    const item = document.createElement("li");
    item.className = "task-row";
    item.dataset.mode = task.mode || "thinking";
    item.dataset.startedAt = String(task.startedAt || 0);
    item.style.setProperty("--row-index", index);

    const signal = document.createElement("i");
    signal.className = "task-signal";

    const copy = document.createElement("div");
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.textContent = task.task || "Codex 任务";
    title.title = task.task || "";
    const workspace = document.createElement("span");
    workspace.textContent = compactPath(task.workspace);
    copy.append(title, workspace);

    const phase = document.createElement("span");
    phase.className = "task-phase";
    phase.textContent = task.phase || "运行中";
    phase.title = task.detail || "";

    const metrics = document.createElement("div");
    metrics.className = "task-metrics";
    const elapsed = document.createElement("time");
    elapsed.textContent = formatTime(task.elapsedSeconds);
    const progress = document.createElement("b");
    progress.textContent = `${Math.max(0, Math.min(100, Number(task.progress) || 0))}%`;
    metrics.append(elapsed, progress);

    const track = document.createElement("span");
    track.className = "task-track";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, Number(task.progress) || 0))}%`;
    track.append(fill);

    item.append(signal, copy, phase, metrics, track);
    elements.taskList.append(item);
  });
}

function animateStateChange(mode, progress) {
  if (lastMode && mode !== lastMode) {
    island.classList.remove("state-pulse");
    void island.offsetWidth;
    island.classList.add("state-pulse");
  }
  if (lastProgress >= 0 && progress !== lastProgress) {
    progressButton.classList.remove("progress-pulse");
    void progressButton.offsetWidth;
    progressButton.classList.add("progress-pulse");
  }
  lastMode = mode;
  lastProgress = progress;
}

function render(state) {
  if (!state) return;
  latestState = state;
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const elapsed = formatTime(state.elapsedSeconds);
  const mode = state.mode || "resting";
  island.dataset.mode = mode;
  island.style.setProperty("--progress", `${progress * 3.6}deg`);
  island.style.setProperty("--progress-percent", `${progress}%`);
  const taskCount = currentTasks(state).length;
  elements.connection.textContent = state.connection === "connected"
    ? `LOCAL CODEX / ${taskCount || 0} ACTIVE`
    : "LOCAL CODEX";
  elements.phase.textContent = state.phase || "等待 Codex";
  elements.detail.textContent = state.task || state.detail || "正在寻找本地任务";
  elements.detail.title = state.detail || "";
  elements.elapsed.textContent = elapsed;
  elements.progress.textContent = String(progress);
  elements.workspace.textContent = compactPath(state.workspace);
  animateStateChange(mode, progress);
  renderTasks(state);
  renderEvents(state.events);
}

async function setExpanded(value) {
  expanded = Boolean(value);
  island.dataset.expanded = String(expanded);
  expandButton.setAttribute("aria-expanded", String(expanded));
  progressButton.setAttribute("aria-label", expanded ? "收起任务详情" : "展开任务详情");
  await window.lumo.resize(expanded, renderedTaskCount);
}

expandButton.addEventListener("click", () => setExpanded(!expanded));
progressButton.addEventListener("click", () => setExpanded(!expanded));
hideButton.addEventListener("click", () => window.lumo.hide());
passButton.addEventListener("click", () => window.lumo.toggleClickThrough());
logsButton.addEventListener("click", () => window.lumo.openLogs());
quitButton.addEventListener("click", () => window.lumo.quit());

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "e") setExpanded(!expanded);
  if (event.key === "Escape" && expanded) setExpanded(false);
});

window.lumo.onState(render);
window.lumo.onClickThrough((enabled) => {
  passButton.textContent = enabled ? "◆" : "◇";
  passButton.title = enabled ? "关闭鼠标穿透（Ctrl Alt L 召回）" : "开启鼠标穿透";
});

document.body.addEventListener("mouseenter", () => window.lumo.setHovered(true));
document.body.addEventListener("mouseleave", () => window.lumo.setHovered(false));

window.lumo.getState().then(render);
setInterval(() => {
  if (!latestState) return;
  const elapsedSeconds = latestState.startedAt
    ? Math.max(0, Math.floor((Date.now() - latestState.startedAt) / 1000))
    : 0;
  elements.elapsed.textContent = formatTime(elapsedSeconds);
  document.querySelectorAll(".task-row").forEach((row) => {
    const startedAt = Number(row.dataset.startedAt || 0);
    const taskElapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
    const time = row.querySelector(".task-metrics time");
    if (time) time.textContent = formatTime(taskElapsed);
  });
}, 1000);
