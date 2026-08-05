const island = document.getElementById("island");
const primary = document.getElementById("primary");
const logsButton = document.getElementById("logsButton");
const quitButton = document.getElementById("quitButton");
const conversationBack = document.getElementById("conversationBack");
const conversationRefresh = document.getElementById("conversationRefresh");

let expanded = false;
let currentView = "tasks";
let conversationSessionId = null;
let conversationData = null;
let lastConversationSignature = "";
let conversationFetchTimer = null;
let conversationFetching = false;
let latestState = null;
let latestSystem = null;
let lastMode = "";
let lastTaskSignature = "";
let renderedTaskCount = 1;
let renderedDelegationRows = 0;
let petActionTimer = null;
let petActionClearTimer = null;
let gesture = null;
let activationTimer = null;
let lastActivationAt = 0;
let powerSaving = false;
let expansionSequence = 0;
const DOUBLE_CLICK_MS = 320;
const MAX_RECENT_COMPLETED_DELEGATIONS = 5;

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
  conversationView: document.getElementById("conversationView"),
  conversationList: document.getElementById("conversationList"),
  conversationEmpty: document.getElementById("conversationEmpty"),
  conversationTitle: document.getElementById("conversationTitle"),
  conversationMeta: document.getElementById("conversationMeta"),
  conversationStatus: document.getElementById("conversationStatus"),
  conversationHint: document.getElementById("conversationHint"),
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

function formatConversationTime(timestamp = 0) {
  const numeric = Number(timestamp) || 0;
  const date = new Date(numeric);
  if (!numeric || !Number.isFinite(date.getTime())) return "--:--";
  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
}

function conversationStatusLabel(status = "") {
  if (status === "completed") return "已完成";
  if (status === "failed") return "异常";
  return "运行中";
}

function conversationPartStatusLabel(status = "") {
  const value = String(status).toLowerCase();
  if (["completed", "complete", "success"].includes(value)) return "已完成";
  if (["running", "pending"].includes(value)) return "执行中";
  if (["failed", "error", "cancelled"].includes(value)) return "异常";
  return status;
}

function relativeUpdateLabel(timestamp = 0) {
  const numeric = Number(timestamp) || 0;
  if (!numeric) return "更新时间未知";
  const seconds = Math.max(0, Math.floor((Date.now() - numeric) / 1000));
  if (seconds < 4) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前更新`;
  return `${Math.floor(seconds / 86400)} 天前更新`;
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
      delegations: state.delegations || [],
    }];
  }
  return [];
}

function displayedDelegations(tasks) {
  return tasks.map((task) => {
    const all = Array.isArray(task.delegations) ? task.delegations : [];
    const sorted = [...all].sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0));
    const running = sorted.filter((delegation) => delegation.status === "running");
    const recent = sorted
      .filter((delegation) => delegation.status !== "running")
      .slice(0, MAX_RECENT_COMPLETED_DELEGATIONS);
    return [...running, ...recent];
  });
}

function delegationStatusLabel(delegation) {
  if (delegation.status === "failed" || delegation.stage === "failed") return "异常";
  if (delegation.status === "completed" || delegation.stage === "completed") return "已完成";
  if (delegation.stage === "thinking") return "分析中";
  if (delegation.stage === "tool") return "执行中";
  if (delegation.stage === "reply") return "回复中";
  return "运行中";
}

function shortModel(value = "") {
  return String(value || "DEFAULT").split("/").at(-1).replace(/-free$/i, "").toUpperCase();
}

function tokenLabel(tokens) {
  const total = Number(tokens?.output || 0) + Number(tokens?.reasoning || 0);
  if (!total) return "";
  return total >= 1000 ? `${(total / 1000).toFixed(1)}K TOK` : `${total} TOK`;
}

function renderTasks(state) {
  const tasks = currentTasks(state);
  const nested = displayedDelegations(tasks);
  const taskSignatures = tasks
    .map((task, index) => [
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
      ...nested[index].flatMap((delegation) => [
        delegation.id,
        delegation.sessionId,
        delegation.status,
        delegation.stage,
        delegation.title,
        delegation.latestUpdate,
        delegation.latestReply,
        delegation.lastEventAt,
        delegation.tokens?.output,
        delegation.tokens?.reasoning,
      ]),
    ].join("~"));
  const signature = taskSignatures.join("|");
  const nextCount = Math.max(1, tasks.length);
  const nextDelegationRows = nested.reduce((total, items) => total + items.length, 0);
  elements.taskCount.textContent = String(tasks.length);

  if (expanded && currentView === "tasks" && (nextCount !== renderedTaskCount || nextDelegationRows !== renderedDelegationRows)) {
    window.lumo.resize(true, nextCount, "tasks", nextDelegationRows);
  }
  renderedTaskCount = nextCount;
  renderedDelegationRows = nextDelegationRows;
  if (signature === lastTaskSignature) return;
  lastTaskSignature = signature;

  if (!tasks.length) {
    elements.taskList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.innerHTML = "<span>暂无正在运行的任务</span><b>STANDBY</b>";
    elements.taskList.append(empty);
    return;
  }

  const existingRows = new Map(
    [...elements.taskList.querySelectorAll(".task-row")].map((row) => [row.dataset.taskId, row]),
  );
  const nextRows = [];
  tasks.forEach((task, index) => {
    const taskKey = task.id || `task-${index}`;
    const existing = existingRows.get(taskKey);
    if (existing?.dataset.signature === taskSignatures[index]) {
      existing.style.setProperty("--row-index", index);
      nextRows.push(existing);
      return;
    }
    const item = document.createElement("li");
    item.className = "task-row";
    if (existing) item.classList.add("is-refresh");
    item.dataset.taskId = taskKey;
    item.dataset.signature = taskSignatures[index];
    item.dataset.mode = task.mode || "thinking";
    item.dataset.startedAt = String(task.startedAt || 0);
    item.dataset.lastEventAt = String(task.lastEventAt || 0);
    item.dataset.replyAt = String(task.replyAt || 0);
    item.style.setProperty("--delegation-rows", nested[index].length);
    item.style.setProperty("--row-index", index);
    item.title = task.task || "Codex 任务";

    const signal = document.createElement("i");
    signal.className = "task-signal";

    const copy = document.createElement("div");
    copy.className = "task-copy";

    const heading = document.createElement("div");
    heading.className = "task-heading";
    const title = document.createElement("strong");
    title.className = "task-name";
    title.textContent = task.task || "Codex 任务";
    title.title = task.task || "";

    const state = document.createElement("span");
    state.className = "task-state";
    const stateDot = document.createElement("i");
    const stateText = document.createElement("b");
    stateText.textContent = task.phase || "运行中";
    state.append(stateDot, stateText);
    heading.append(title, state);

    const activity = document.createElement("p");
    activity.className = "task-line task-activity";
    const activityLabel = document.createElement("span");
    activityLabel.className = "task-line-label";
    const activityDot = document.createElement("i");
    const activityLabelText = document.createElement("b");
    activityLabelText.textContent = "当前";
    activityLabel.append(activityDot, activityLabelText);
    const activityText = document.createElement("span");
    activityText.className = "task-line-text";
    activityText.textContent = task.detail || "正在等待任务事件";
    activityText.title = task.detail || "";

    const duration = document.createElement("span");
    duration.className = "task-duration";
    const durationLabel = document.createElement("b");
    durationLabel.textContent = "已运行";
    const elapsed = document.createElement("time");
    elapsed.className = "task-elapsed";
    elapsed.textContent = formatTime(task.elapsedSeconds);
    duration.append(durationLabel, elapsed);
    activity.append(activityLabel, activityText, duration);

    const reply = document.createElement("p");
    reply.className = "task-line task-reply";
    const replyLabel = document.createElement("span");
    replyLabel.className = "task-line-label";
    const replyMark = document.createElement("i");
    const replyLabelText = document.createElement("b");
    replyLabelText.textContent = "回复";
    replyLabel.append(replyMark, replyLabelText);
    const replyText = document.createElement("span");
    replyText.className = "task-line-text";
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
    started.className = "task-started";
    started.textContent = `${formatClock(task.startedAt)} 开始`;
    started.dateTime = task.startedAt ? new Date(task.startedAt).toISOString() : "";
    const thread = document.createElement("code");
    thread.textContent = `#${shortThreadId(task.id)}`;
    thread.title = task.id || "本地任务";
    const updated = document.createElement("span");
    updated.className = "task-updated";
    updated.textContent = relativeUpdateLabel(task.lastEventAt);
    meta.append(workspace, started, thread, updated);
    copy.append(heading, activity, reply, meta);

    if (nested[index].length) {
      const delegationList = document.createElement("div");
      delegationList.className = "task-delegations";
      nested[index].forEach((delegation) => {
        const child = document.createElement("div");
        child.className = "task-delegation";
        child.dataset.status = delegation.status || "running";
        child.dataset.startedAt = String(delegation.startedAt || 0);
        child.dataset.completedAt = String(delegation.completedAt || 0);

        const provider = document.createElement("span");
        provider.className = "delegation-provider";
        provider.textContent = "OC";
        provider.title = "OpenCode 子任务";

        const childCopy = document.createElement("span");
        childCopy.className = "delegation-copy";
        const childTitle = document.createElement("b");
        const baseChildTitle = delegation.sessionTitle || delegation.title || "OpenCode 子任务";
        childTitle.textContent = delegation.rounds > 1 ? `${baseChildTitle} · ${delegation.rounds} 轮` : baseChildTitle;
        childTitle.title = delegation.sessionTitle || delegation.title || "";
        const childUpdate = document.createElement("em");
        childUpdate.textContent = delegation.latestUpdate || "等待 OpenCode 会话数据";
        childUpdate.title = delegation.latestReply || delegation.latestUpdate || "";
        childCopy.append(childTitle, childUpdate);

        const childMeta = document.createElement("span");
        childMeta.className = "delegation-meta";
        const model = document.createElement("code");
        model.textContent = shortModel(delegation.model);
        const tokens = document.createElement("small");
        tokens.textContent = tokenLabel(delegation.tokens);
        const childStatus = document.createElement("strong");
        childStatus.textContent = delegationStatusLabel(delegation);
        const childElapsed = document.createElement("time");
        childElapsed.className = "delegation-elapsed";
        childElapsed.textContent = formatTime(delegation.elapsedSeconds);
        childMeta.append(model, tokens, childStatus, childElapsed);

        const logButton = document.createElement("button");
        logButton.type = "button";
        logButton.className = "delegation-log";
        logButton.textContent = "日志/对话";
        logButton.disabled = !delegation.sessionId;
        logButton.title = delegation.sessionId
          ? "查看该会话的日志与对话（只读）"
          : "该会话尚未匹配到 OpenCode 会话";
        logButton.addEventListener("click", () => {
          if (delegation.sessionId) openConversation(delegation.sessionId);
        });

        child.append(provider, childCopy, childMeta, logButton);
        delegationList.append(child);
      });
      copy.append(delegationList);
    }

    const track = document.createElement("span");
    track.className = "task-track";
    const fill = document.createElement("i");
    track.append(fill);

    item.append(signal, copy, track);
    nextRows.push(item);
  });
  elements.taskList.replaceChildren(...nextRows);
}

function resizeForCurrentView() {
  if (currentView === "conversation") {
    return window.lumo.resize(true, 1, "conversation", 0);
  }
  return window.lumo.resize(true, renderedTaskCount, "tasks", renderedDelegationRows);
}

function buildConversationList(data) {
  const fragment = document.createDocumentFragment();
  (data.entries || []).forEach((entry) => {
    const item = document.createElement("li");
    item.className = `conversation-entry conversation-${entry.type || "part"}`;
    if (entry.type === "tool") item.dataset.status = entry.status || "";

    const head = document.createElement("div");
    head.className = "conversation-entry-head";
    const label = document.createElement("span");
    label.className = "conversation-entry-label";
    const labelText = document.createElement("b");
    labelText.textContent = entry.label || "条目";
    label.append(labelText);
    if (entry.type === "tool" && entry.status) {
      const status = document.createElement("em");
      status.className = "conversation-entry-status";
      status.textContent = conversationPartStatusLabel(entry.status);
      label.append(status);
    }
    const time = document.createElement("time");
    time.textContent = formatConversationTime(entry.timestamp);
    time.dateTime = entry.timestamp ? new Date(Number(entry.timestamp)).toISOString() : "";
    head.append(label, time);

    const body = document.createElement("div");
    body.className = "conversation-entry-body";
    const text = document.createElement("p");
    text.className = "conversation-entry-text";
    text.textContent = entry.text || "";
    text.title = entry.text || "";
    if (entry.type === "reasoning") {
      const details = document.createElement("details");
      details.className = "conversation-details";
      const summary = document.createElement("summary");
      summary.textContent = "展开分析内容";
      details.append(summary, text);
      body.append(details);
    } else {
      body.append(text);
    }

    item.append(head, body);
    fragment.append(item);
  });
  return fragment;
}

function renderConversation(data, silent = false) {
  const list = elements.conversationList;
  const empty = elements.conversationEmpty;
  if (!data || data.available === false || !data.sessionId) {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = (data && data.error) || "暂无会话数据 · 无法读取 OpenCode 会话日志";
    return;
  }
  const signature = JSON.stringify({
    sessionId: data.sessionId,
    status: data.status,
    updatedAt: data.updatedAt,
    truncated: data.truncated,
    entries: (data.entries || []).map((entry) => `${entry.type}:${entry.timestamp}:${entry.text.length}`).join("|"),
  });
  if (silent && signature === lastConversationSignature) return;
  const keepAtBottom = !silent || list.scrollHeight - list.scrollTop - list.clientHeight < 36;
  lastConversationSignature = signature;
  conversationData = data;

  elements.conversationTitle.textContent = data.title || "OpenCode 会话";
  elements.conversationTitle.title = data.title || data.sessionId || "";
  elements.conversationStatus.textContent = conversationStatusLabel(data.status);
  elements.conversationStatus.dataset.status = data.status || "running";
  const metaParts = [];
  if (data.directory) metaParts.push(data.directory);
  if (data.startedAt) metaParts.push(`开始 ${formatConversationTime(data.startedAt)}`);
  if (data.updatedAt) metaParts.push(`更新 ${formatConversationTime(data.updatedAt)}`);
  elements.conversationMeta.textContent = metaParts.join(" · ");
  elements.conversationMeta.title = metaParts.join("\n");
  elements.conversationHint.textContent = data.truncated
    ? "只读视图 · 新事件自动刷新 · 已截断，仅显示最近记录"
    : "只读视图 · 新事件自动刷新 · 不写入会话";

  list.replaceChildren(buildConversationList(data));
  if (keepAtBottom) list.scrollTop = list.scrollHeight;
  empty.hidden = Boolean(data.entries?.length);
  if (!empty.hidden) empty.textContent = "该会话暂无消息记录";
}

async function openConversation(sessionId) {
  if (!sessionId) return;
  currentView = "conversation";
  conversationSessionId = sessionId;
  conversationData = null;
  lastConversationSignature = "";
  clearTimeout(conversationFetchTimer);
  conversationFetchTimer = null;
  island.dataset.view = "conversation";
  elements.conversationView.hidden = false;
  elements.conversationList.replaceChildren();
  elements.conversationEmpty.hidden = false;
  elements.conversationEmpty.textContent = "正在读取会话日志…";
  elements.conversationTitle.textContent = "OpenCode 会话";
  elements.conversationMeta.textContent = "";
  elements.conversationStatus.textContent = "运行中";
  elements.conversationStatus.dataset.status = "running";
  elements.conversationHint.textContent = "只读视图 · 新事件自动刷新 · 不写入会话";
  await resizeForCurrentView();
  conversationFetching = true;
  let data = null;
  try {
    data = await window.lumo.getOpenCodeConversation(sessionId);
  } finally {
    conversationFetching = false;
  }
  if (currentView !== "conversation" || conversationSessionId !== sessionId) return;
  renderConversation(data);
}

async function closeConversation() {
  if (currentView !== "conversation") return;
  currentView = "tasks";
  conversationSessionId = null;
  conversationData = null;
  clearTimeout(conversationFetchTimer);
  conversationFetchTimer = null;
  delete island.dataset.view;
  elements.conversationView.hidden = true;
  await resizeForCurrentView();
  renderTasks(latestState);
}

async function refreshConversation() {
  if (!conversationSessionId || conversationFetching) return;
  clearTimeout(conversationFetchTimer);
  conversationFetchTimer = null;
  conversationFetching = true;
  const requestedSessionId = conversationSessionId;
  try {
    const data = await window.lumo.getOpenCodeConversation(requestedSessionId);
    if (currentView !== "conversation" || conversationSessionId !== requestedSessionId) return;
    renderConversation(data, true);
  } finally {
    conversationFetching = false;
  }
}

function maybeRefreshConversation() {
  if (currentView !== "conversation" || !conversationSessionId || powerSaving) return;
  if (conversationData && conversationData.status !== "running") return;
  if (conversationFetchTimer || conversationFetching) return;
  conversationFetchTimer = setTimeout(() => {
    conversationFetchTimer = null;
    refreshConversation();
  }, 1100);
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

function animateStateChange(mode) {
  if (mode !== lastMode) schedulePetAction(mode);
  lastMode = mode;
}

function render(state) {
  if (!state) return;
  latestState = state;
  if (powerSaving) return;
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
  animateStateChange(mode);
  renderTasks(state);
  maybeRefreshConversation();
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
    await resizeForCurrentView();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (sequence !== expansionSequence) return;
    island.dataset.expanded = "true";
    await waitForMotion(320);
    if (currentView === "conversation") refreshConversation();
  } else {
    island.dataset.transition = "closing";
    await waitForMotion(120);
    if (sequence !== expansionSequence) return;
    island.dataset.expanded = "false";
    await window.lumo.resize(false, renderedTaskCount, "tasks", renderedDelegationRows);
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
conversationBack.addEventListener("click", () => closeConversation());
conversationRefresh.addEventListener("click", () => refreshConversation());

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "e") {
    if (currentView === "conversation") closeConversation();
    else setExpanded(!expanded);
  }
  if (event.key === "Escape") {
    if (currentView === "conversation") closeConversation();
    else if (expanded) setExpanded(false);
  }
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
    clearTimeout(activationTimer);
    lastActivationAt = 0;
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
    if (updated) updated.textContent = relativeUpdateLabel(Number(row.dataset.lastEventAt || 0));
    row.querySelectorAll(".task-delegation").forEach((child) => {
      const childStartedAt = Number(child.dataset.startedAt || 0);
      const childCompletedAt = Number(child.dataset.completedAt || 0);
      const childElapsed = childStartedAt
        ? Math.max(0, Math.floor(((childCompletedAt || Date.now()) - childStartedAt) / 1000))
        : 0;
      const childTime = child.querySelector(".delegation-elapsed");
      if (childTime) childTime.textContent = formatTime(childElapsed);
    });
  });
  if (latestSystem?.updatedAt) {
    const age = Math.max(0, Math.floor((Date.now() - latestSystem.updatedAt) / 1000));
    if (age > 6) elements.systemUpdated.textContent = `${age}S AGO`;
  }
}, 1000);
