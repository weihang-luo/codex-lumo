const island = document.getElementById("island");
const expandButton = document.getElementById("expandButton");
const progressButton = document.getElementById("progressButton");
const hideButton = document.getElementById("hideButton");
const passButton = document.getElementById("passButton");
const logsButton = document.getElementById("logsButton");
const quitButton = document.getElementById("quitButton");

let expanded = false;
let latestState = null;

const elements = {
  connection: document.getElementById("connection"),
  phase: document.getElementById("phase"),
  detail: document.getElementById("detail"),
  elapsed: document.getElementById("elapsed"),
  progress: document.getElementById("progress"),
  task: document.getElementById("task"),
  track: document.getElementById("track"),
  statPhase: document.getElementById("statPhase"),
  statProgress: document.getElementById("statProgress"),
  statElapsed: document.getElementById("statElapsed"),
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

function render(state) {
  if (!state) return;
  latestState = state;
  const progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
  const elapsed = formatTime(state.elapsedSeconds);
  island.dataset.mode = state.mode || "resting";
  island.style.setProperty("--progress", `${progress * 3.6}deg`);
  elements.connection.textContent = state.connection === "connected" ? "LOCAL CODEX / LIVE" : "LOCAL CODEX";
  elements.phase.textContent = state.phase || "等待 Codex";
  elements.detail.textContent = state.detail || "正在寻找本地任务";
  elements.elapsed.textContent = elapsed;
  elements.progress.textContent = String(progress);
  elements.task.textContent = state.task || "等待下一项任务";
  elements.track.style.width = `${progress}%`;
  elements.statPhase.textContent = state.phase || "待机";
  elements.statProgress.textContent = `${progress}%`;
  elements.statElapsed.textContent = elapsed;
  elements.workspace.textContent = compactPath(state.workspace);
  renderEvents(state.events);
}

async function setExpanded(value) {
  expanded = Boolean(value);
  island.dataset.expanded = String(expanded);
  expandButton.setAttribute("aria-expanded", String(expanded));
  progressButton.setAttribute("aria-label", expanded ? "收起任务详情" : "展开任务详情");
  await window.lumo.resize(expanded);
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

window.lumo.getState().then(render);
setInterval(() => {
  if (!latestState) return;
  const elapsedSeconds = latestState.startedAt
    ? Math.max(0, Math.floor((Date.now() - latestState.startedAt) / 1000))
    : 0;
  elements.elapsed.textContent = formatTime(elapsedSeconds);
  elements.statElapsed.textContent = formatTime(elapsedSeconds);
}, 1000);
