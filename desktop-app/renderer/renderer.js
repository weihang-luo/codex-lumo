const island = document.getElementById("island");
const primary = document.getElementById("primary");
const logsButton = document.getElementById("logsButton");
const quitButton = document.getElementById("quitButton");

let expanded = false;
let latestState = null;
let latestSystem = null;
let lastMode = "";
let lastProgress = -1;
let lastTaskSignature = "";
let renderedTaskCount = 1;
let statePulseTimer = null;
let petActionTimer = null;
let petActionClearTimer = null;
let gesture = null;

const PET_ACTIONS = {
  thinking: [
    { name: "ponder", duration: 2200 },
    { name: "calculate", duration: 1900 },
    { name: "idea", duration: 1800 },
  ],
  working: [
    { name: "type", duration: 1700 },
    { name: "scan", duration: 2000 },
    { name: "build", duration: 1800 },
    { name: "dash", duration: 1700 },
  ],
  waiting: [
    { name: "peek", duration: 1900 },
    { name: "listen", duration: 2300 },
    { name: "tap", duration: 1800 },
  ],
  done: [
    { name: "cheer", duration: 1800 },
    { name: "jump", duration: 1600 },
    { name: "wave", duration: 2000 },
    { name: "dance", duration: 2200 },
  ],
  error: [
    { name: "panic", duration: 1500 },
    { name: "diagnose", duration: 2200 },
    { name: "reboot", duration: 2000 },
  ],
  resting: [
    { name: "look", duration: 1700 },
    { name: "wave", duration: 1600 },
    { name: "stretch", duration: 1800 },
    { name: "dance", duration: 2200 },
    { name: "shuffle", duration: 2100 },
    { name: "moonwalk", duration: 2400 },
    { name: "spin", duration: 1900 },
    { name: "robot", duration: 2300 },
    { name: "bounce", duration: 1900 },
  ],
  offline: [
    { name: "sleep", duration: 2800 },
    { name: "power-save", duration: 2400 },
  ],
};
const lastActionByMode = new Map();

const elements = {
  connection: document.getElementById("connection"),
  phase: document.getElementById("phase"),
  detail: document.getElementById("detail"),
  taskTitle: document.getElementById("taskTitle"),
  elapsed: document.getElementById("elapsed"),
  taskCount: document.getElementById("taskCount"),
  taskList: document.getElementById("taskList"),
  workspace: document.getElementById("workspace"),
  events: document.getElementById("events"),
  cpuValue: document.getElementById("cpuValue"),
  memoryValue: document.getElementById("memoryValue"),
  cpuDetail: document.getElementById("cpuDetail"),
  memoryDetail: document.getElementById("memoryDetail"),
  cpuBar: document.getElementById("cpuBar"),
  memoryBar: document.getElementById("memoryBar"),
  systemUpdated: document.getElementById("systemUpdated"),
};

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

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
    window.lumo.resize(true, nextCount, "tasks");
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

    const phase = document.createElement("div");
    phase.className = "task-phase";
    const phaseName = document.createElement("strong");
    phaseName.textContent = task.phase || "运行中";
    const phaseDetail = document.createElement("span");
    phaseDetail.textContent = task.detail || "";
    phase.append(phaseName, phaseDetail);

    const metrics = document.createElement("div");
    metrics.className = "task-metrics";
    const elapsed = document.createElement("time");
    elapsed.textContent = formatTime(task.elapsedSeconds);
    const activity = document.createElement("b");
    activity.textContent = task.mode === "waiting" ? "WAIT" : "LIVE";
    metrics.append(elapsed, activity);

    const track = document.createElement("span");
    track.className = "task-track";
    const fill = document.createElement("i");
    track.append(fill);

    item.append(signal, copy, phase, metrics, track);
    elements.taskList.append(item);
  });
}

function nextPetAction(mode) {
  const actions = PET_ACTIONS[mode] || PET_ACTIONS.resting;
  const previous = lastActionByMode.get(mode);
  const candidates = actions.length > 1 ? actions.filter((action) => action.name !== previous) : actions;
  const action = candidates[Math.floor(Math.random() * candidates.length)];
  lastActionByMode.set(mode, action.name);
  return action;
}

function schedulePetAction(mode, delay = 0) {
  clearTimeout(petActionTimer);
  clearTimeout(petActionClearTimer);
  delete island.dataset.action;

  const play = () => {
    if (island.dataset.mode !== mode) return;
    const action = nextPetAction(mode);
    island.dataset.action = action.name;
    petActionClearTimer = setTimeout(() => {
      delete island.dataset.action;
      const gap = mode === "resting"
        ? 1200 + Math.floor(Math.random() * 2400)
        : 380 + Math.floor(Math.random() * 720);
      petActionTimer = setTimeout(() => schedulePetAction(island.dataset.mode), gap);
    }, action.duration);
  };

  if (delay > 0) petActionTimer = setTimeout(play, delay);
  else play();
}

function animateStateChange(mode, progress) {
  if (mode !== lastMode) schedulePetAction(mode);
  if ((lastMode && mode !== lastMode) || (lastProgress >= 0 && progress !== lastProgress)) {
    clearTimeout(statePulseTimer);
    island.classList.remove("state-pulse");
    void island.offsetWidth;
    island.classList.add("state-pulse");
    statePulseTimer = setTimeout(() => island.classList.remove("state-pulse"), 680);
  }
  lastMode = mode;
  lastProgress = progress;
}

function render(state) {
  if (!state) return;
  latestState = state;
  const progress = clamp(state.progress);
  const mode = state.mode || "resting";
  const taskCount = currentTasks(state).length;
  island.dataset.mode = mode;
  island.dataset.activeTasks = String(taskCount);
  elements.connection.textContent = state.connection === "connected"
    ? `CODEX / ${taskCount || 0} ACTIVE`
    : "LOCAL CODEX";
  elements.phase.textContent = state.phase || "等待 Codex";
  elements.detail.textContent = state.detail || "正在寻找本地任务";
  elements.detail.title = state.detail || "";
  elements.taskTitle.textContent = state.task || "等待下一项任务";
  elements.taskTitle.title = state.task || "";
  elements.elapsed.textContent = formatTime(state.elapsedSeconds);
  elements.workspace.textContent = compactPath(state.workspace);
  animateStateChange(mode, progress);
  renderTasks(state);
  renderEvents(state.events);
}

function renderSystem(state) {
  if (!state) return;
  latestSystem = state;
  const cpu = clamp(state.cpu);
  const memory = clamp(state.memory);

  elements.cpuValue.textContent = String(cpu);
  elements.memoryValue.textContent = String(memory);
  elements.cpuDetail.textContent = String(cpu);
  elements.memoryDetail.textContent = String(memory);
  elements.cpuBar.style.width = `${cpu}%`;
  elements.memoryBar.style.width = `${memory}%`;
  elements.systemUpdated.textContent = "LIVE";
  island.dataset.systemLoad = cpu >= 85 || memory >= 90 ? "high" : "normal";
}

async function setExpanded(value) {
  expanded = Boolean(value);
  island.dataset.expanded = String(expanded);
  primary.setAttribute("aria-expanded", String(expanded));
  await window.lumo.resize(expanded, renderedTaskCount, "tasks");
}

function isInteractive(target) {
  return target instanceof Element && Boolean(target.closest("button, a"));
}

function finishGesture(event, cancelled = false) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const completed = gesture;
  gesture = null;
  if (island.hasPointerCapture(event.pointerId)) island.releasePointerCapture(event.pointerId);
  completed.ready
    .then(() => window.lumo.endDrag(completed.moved))
    .then(() => {
      if (!cancelled && !completed.moved && completed.startedInPrimary) setExpanded(!expanded);
    });
}

island.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || isInteractive(event.target)) return;
  gesture = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    moved: false,
    startedInPrimary: Boolean(event.target.closest(".primary")),
    ready: window.lumo.startDrag(event.screenX, event.screenY),
  };
  island.setPointerCapture(event.pointerId);
  event.preventDefault();
});

island.addEventListener("pointermove", (event) => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const distance = Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY);
  if (distance < 4 && !gesture.moved) return;
  gesture.moved = true;
  gesture.ready.then(() => window.lumo.moveDrag(event.screenX, event.screenY));
});

island.addEventListener("pointerup", (event) => finishGesture(event));
island.addEventListener("pointercancel", (event) => finishGesture(event, true));

primary.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setExpanded(!expanded);
  }
});

logsButton.addEventListener("click", () => window.lumo.openLogs());
quitButton.addEventListener("click", () => window.lumo.quit());

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "e") setExpanded(!expanded);
  if (event.key === "Escape" && expanded) setExpanded(false);
});

window.lumo.onState(render);
window.lumo.onSystem(renderSystem);
window.lumo.onSettings((settings) => {
  document.body.dataset.windowSize = settings.windowSize || "medium";
});
window.lumo.onDockMotion((phase) => {
  island.dataset.dockMotion = phase || "visible";
});

document.body.addEventListener("mouseenter", () => window.lumo.setHovered(true));
document.body.addEventListener("mouseleave", () => window.lumo.setHovered(false));

window.lumo.getSettings().then((settings) => {
  document.body.dataset.windowSize = settings.windowSize || "medium";
});
window.lumo.getState().then(render);
window.lumo.getSystem().then(renderSystem);

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
  if (latestSystem?.updatedAt) {
    const age = Math.max(0, Math.floor((Date.now() - latestSystem.updatedAt) / 1000));
    if (age > 6) elements.systemUpdated.textContent = `${age}S AGO`;
  }
}, 1000);
