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
let activationTimer = null;
let lastActivationAt = 0;
let powerSaving = false;
let expansionSequence = 0;
const DOUBLE_CLICK_MS = 320;

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
  reply: [
    { name: "cheer", duration: 1800 },
    { name: "wave", duration: 2000 },
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
  compactWorkspace: document.getElementById("compactWorkspace"),
  cpuValue: document.getElementById("cpuValue"),
  memoryValue: document.getElementById("memoryValue"),
  quotaMetric: document.getElementById("quotaMetric"),
  quotaValue: document.getElementById("quotaValue"),
  quotaUnit: document.getElementById("quotaUnit"),
  cpuDetail: document.getElementById("cpuDetail"),
  memoryDetail: document.getElementById("memoryDetail"),
  quotaCard: document.getElementById("quotaCard"),
  quotaLabel: document.getElementById("quotaLabel"),
  quotaDetail: document.getElementById("quotaDetail"),
  quotaDetailUnit: document.getElementById("quotaDetailUnit"),
  cpuBar: document.getElementById("cpuBar"),
  memoryBar: document.getElementById("memoryBar"),
  quotaBar: document.getElementById("quotaBar"),
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

function formatClock(timestamp = 0) {
  const date = new Date(Number(timestamp) || 0);
  if (!Number(timestamp) || !Number.isFinite(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function relativeAge(timestamp = 0) {
  const numeric = Number(timestamp) || 0;
  if (!numeric) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - numeric) / 1000));
  if (seconds < 4) return "NOW";
  if (seconds < 60) return `${seconds}S`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H`;
  return `${Math.floor(seconds / 86400)}D`;
}

function shortThreadId(value = "") {
  const compact = String(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
  return compact ? compact.slice(0, 8) : "LOCAL";
}

function quotaWindowLabel(minutes = 0) {
  const value = Math.max(0, Number(minutes) || 0);
  if (value === 10080) return "WEEK";
  if (value >= 1440) return `${Math.round(value / 1440)}D`;
  if (value >= 60) return `${Math.round(value / 60)}H`;
  return value ? `${Math.round(value)}M` : "QUOTA";
}

function quotaResetTimeLabel(resetsAt = 0) {
  const numeric = Number(resetsAt) || 0;
  if (!numeric) return "";
  const timestamp = numeric < 1e12 ? numeric * 1000 : numeric;
  const reset = new Date(timestamp);
  if (!Number.isFinite(reset.getTime())) return "";
  const now = new Date();
  const sameDay = reset.getFullYear() === now.getFullYear()
    && reset.getMonth() === now.getMonth()
    && reset.getDate() === now.getDate();
  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`;
  return sameDay
    ? `RESET ${time}`
    : `RESET ${pad(reset.getMonth() + 1)}/${pad(reset.getDate())} ${time}`;
}

function renderQuota(quota) {
  const available = Boolean(quota?.available);
  const unlimited = available && Boolean(quota.unlimited);
  const remaining = available ? Math.round(clamp(quota.remainingPercent)) : 0;
  const value = unlimited ? "∞" : available ? String(remaining) : "--";
  const unit = available && !unlimited ? "%" : "";
  const windowLabel = quotaWindowLabel(quota?.windowMinutes);
  const resetTimeLabel = quotaResetTimeLabel(quota?.resetsAt);
  const resetTimestamp = Number(quota?.resetsAt) || 0;
  const resetDate = resetTimestamp
    ? new Date(resetTimestamp < 1e12 ? resetTimestamp * 1000 : resetTimestamp).toLocaleString("zh-CN")
    : "";
  const title = available
    ? `${quota.limitName || "Codex"}：${unlimited ? "无限额度" : `剩余 ${remaining}%`}${resetDate ? ` · ${resetDate} 重置` : ""}`
    : "暂未从 Codex 日志读取到额度";

  elements.quotaValue.textContent = value;
  elements.quotaUnit.textContent = unit;
  elements.quotaDetail.textContent = value;
  elements.quotaDetailUnit.textContent = unit;
  elements.quotaLabel.textContent = available
    ? resetTimeLabel || `${windowLabel} LEFT`
    : "QUOTA LEFT";
  elements.quotaBar.style.width = `${unlimited ? 100 : remaining}%`;
  elements.quotaMetric.title = title;
  elements.quotaCard.title = title;
  island.dataset.quota = !available ? "unknown" : remaining <= 20 ? "low" : "normal";
}

function currentTasks(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  if (tasks.length) return tasks;
  if (["thinking", "working", "waiting", "reply", "error"].includes(state?.mode)) {
    return [{
      id: state.threadId,
      task: state.task,
      mode: state.mode,
      phase: state.phase,
      detail: state.detail,
      progress: state.progress,
      startedAt: state.startedAt,
      lastEventAt: state.lastEventAt,
      workspace: state.workspace,
      latestReply: state.latestReply,
      replyAt: state.replyAt,
    }];
  }
  return [];
}

function renderTasks(state) {
  const tasks = currentTasks(state);
  const signature = tasks
    .map((task) => [
      task.id,
      task.task,
      task.mode,
      task.phase,
      task.detail,
      task.progress,
      task.workspace,
      task.startedAt,
      task.lastEventAt,
      task.latestReply,
      task.replyAt,
    ].join("~"))
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
    item.dataset.lastEventAt = String(task.lastEventAt || 0);
    item.dataset.replyAt = String(task.replyAt || 0);
    item.style.setProperty("--row-index", index);
    item.title = task.task || "Codex 任务";

    const signal = document.createElement("i");
    signal.className = "task-signal";

    const copy = document.createElement("div");
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.className = "task-name";
    title.textContent = task.task || "Codex 任务";
    title.title = task.task || "";

    const activity = document.createElement("p");
    activity.className = "task-context task-activity";
    const activityLabel = document.createElement("b");
    activityLabel.textContent = "NOW";
    const activityText = document.createElement("span");
    activityText.textContent = task.detail || "正在等待任务事件";
    activityText.title = task.detail || "";
    activity.append(activityLabel, activityText);

    const reply = document.createElement("p");
    reply.className = "task-context task-reply";
    const replyLabel = document.createElement("b");
    replyLabel.textContent = "REPLY";
    const replyText = document.createElement("span");
    replyText.textContent = task.latestReply || "尚无可见回复";
    replyText.title = task.latestReply || "";
    if (!task.latestReply) reply.classList.add("is-empty");
    reply.append(replyLabel, replyText);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const workspace = document.createElement("span");
    workspace.className = "task-workspace";
    workspace.textContent = compactPath(task.workspace);
    workspace.title = task.workspace || "";
    const started = document.createElement("time");
    started.textContent = `START ${formatClock(task.startedAt)}`;
    started.dateTime = task.startedAt ? new Date(task.startedAt).toISOString() : "";
    const thread = document.createElement("code");
    thread.textContent = `#${shortThreadId(task.id)}`;
    thread.title = task.id || "本地任务";
    meta.append(workspace, started, thread);
    copy.append(title, activity, reply, meta);

    const metrics = document.createElement("div");
    metrics.className = "task-metrics";
    const phaseName = document.createElement("strong");
    phaseName.textContent = task.phase || "运行中";
    const elapsed = document.createElement("time");
    elapsed.className = "task-elapsed";
    elapsed.textContent = formatTime(task.elapsedSeconds);
    const updated = document.createElement("span");
    updated.className = "task-updated";
    updated.textContent = `UPDATE ${relativeAge(task.lastEventAt)}`;
    metrics.append(phaseName, elapsed, updated);

    const track = document.createElement("span");
    track.className = "task-track";
    const fill = document.createElement("i");
    track.append(fill);

    item.append(signal, copy, metrics, track);
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
  if (powerSaving) return;
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
  const latestContext = state.latestReply || state.task || "等待下一项任务";
  elements.taskTitle.textContent = latestContext;
  elements.taskTitle.title = latestContext;
  elements.elapsed.textContent = formatTime(state.elapsedSeconds);
  const workspaceLabel = compactPath(state.workspace);
  elements.compactWorkspace.textContent = workspaceLabel;
  elements.compactWorkspace.title = state.workspace || "";
  renderQuota(state.quota);
  animateStateChange(mode, progress);
  renderTasks(state);
}

function renderSystem(state) {
  if (!state) return;
  latestSystem = state;
  if (powerSaving) return;
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

function waitForMotion(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setExpanded(value) {
  const target = Boolean(value);
  if (target === expanded && !island.dataset.transition) return;
  const sequence = ++expansionSequence;
  expanded = target;
  primary.setAttribute("aria-expanded", String(target));

  if (target) {
    island.dataset.transition = "opening";
    await window.lumo.resize(true, renderedTaskCount, "tasks");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (sequence !== expansionSequence) return;
    island.dataset.expanded = "true";
    await waitForMotion(320);
  } else {
    island.dataset.transition = "closing";
    await waitForMotion(120);
    if (sequence !== expansionSequence) return;
    island.dataset.expanded = "false";
    await window.lumo.resize(false, renderedTaskCount, "tasks");
    await waitForMotion(250);
  }

  if (sequence === expansionSequence) delete island.dataset.transition;
}

function isInteractive(target) {
  return target instanceof Element && Boolean(target.closest("button, a"));
}

function activateWindow(startedInPrimary, activationAt) {
  const elapsed = activationAt - lastActivationAt;
  if (lastActivationAt && elapsed >= 0 && elapsed <= DOUBLE_CLICK_MS) {
    clearTimeout(activationTimer);
    activationTimer = null;
    lastActivationAt = 0;
    window.lumo.openCodex();
    return;
  }

  clearTimeout(activationTimer);
  lastActivationAt = activationAt;
  activationTimer = setTimeout(() => {
    activationTimer = null;
    lastActivationAt = 0;
    if (startedInPrimary) setExpanded(!expanded);
  }, DOUBLE_CLICK_MS);
}

function finishGesture(event, cancelled = false) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const completed = gesture;
  const activationAt = Date.now();
  gesture = null;
  if (island.hasPointerCapture(event.pointerId)) island.releasePointerCapture(event.pointerId);
  completed.ready
    .then(() => window.lumo.endDrag(completed.moved))
    .then(() => {
      if (!cancelled && !completed.moved) activateWindow(completed.startedInPrimary, activationAt);
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
window.lumo.onPowerSave((enabled) => {
  powerSaving = enabled;
  island.dataset.powerSave = String(powerSaving);
  if (powerSaving) {
    clearTimeout(petActionTimer);
    clearTimeout(petActionClearTimer);
    clearTimeout(statePulseTimer);
    clearTimeout(activationTimer);
    lastActivationAt = 0;
    island.classList.remove("state-pulse");
    delete island.dataset.action;
    return;
  }
  render(latestState);
  renderSystem(latestSystem);
  schedulePetAction(island.dataset.mode || "resting", 300);
});

document.body.addEventListener("mouseenter", () => window.lumo.setHovered(true));
document.body.addEventListener("mouseleave", () => window.lumo.setHovered(false));

window.lumo.getSettings().then((settings) => {
  document.body.dataset.windowSize = settings.windowSize || "medium";
});
window.lumo.getState().then(render);
window.lumo.getSystem().then(renderSystem);

setInterval(() => {
  if (!latestState || powerSaving) return;
  const elapsedSeconds = latestState.startedAt
    ? Math.max(0, Math.floor((Date.now() - latestState.startedAt) / 1000))
    : 0;
  elements.elapsed.textContent = formatTime(elapsedSeconds);
  document.querySelectorAll(".task-row").forEach((row) => {
    const startedAt = Number(row.dataset.startedAt || 0);
    const taskElapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
    const time = row.querySelector(".task-elapsed");
    if (time) time.textContent = formatTime(taskElapsed);
    const updated = row.querySelector(".task-updated");
    if (updated) updated.textContent = `UPDATE ${relativeAge(Number(row.dataset.lastEventAt || 0))}`;
  });
  if (latestSystem?.updatedAt) {
    const age = Math.max(0, Math.floor((Date.now() - latestSystem.updatedAt) / 1000));
    if (age > 6) elements.systemUpdated.textContent = `${age}S AGO`;
  }
}, 1000);
