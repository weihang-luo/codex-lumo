const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeDisplayText } = require("./text-quality.cjs");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  // OpenCode enrichment is optional on older Electron runtimes.
}

const SESSION_MATCH_WINDOW_MS = 2 * 60 * 1000;
const DISCOVERY_LOOKBACK_MS = 2 * 60 * 1000;
const DISCOVERY_FORWARD_MS = 10 * 60 * 1000;
const DISCOVERY_LIMIT = 120;
const CONVERSATION_ENTRY_LIMIT = 320;

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value = "") {
  return String(value)
    .replace(/\\[rnt]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
}

function normalizePath(value = "") {
  return String(value).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function directoryRelationScore(expected = "", actual = "") {
  const parent = normalizePath(expected);
  const child = normalizePath(actual);
  if (!parent || !child) return 0;
  if (parent === child) return 3000 + parent.length;
  if (child.startsWith(`${parent}/`)) return 2000 + parent.length;
  if (parent.startsWith(`${child}/`)) return 1000 + child.length;
  return 0;
}

function taskDirectories(task = {}) {
  return [...new Set([
    task.openCodeHintDirectory,
    task.workspace,
    ...(task.delegations || []).map((delegation) => delegation.directory),
  ].map(normalizePath).filter(Boolean))];
}

function discoveryTaskScore(task, session) {
  const evidenceAt = Number(task.openCodeHintAt || task.startedAt) || 0;
  const createdAt = Number(session.time_created) || 0;
  if (!evidenceAt
    || createdAt < evidenceAt - DISCOVERY_LOOKBACK_MS
    || createdAt > evidenceAt + DISCOVERY_FORWARD_MS) return 0;
  const pathScore = Math.max(0, ...taskDirectories(task).map((directory) =>
    directoryRelationScore(directory, session.directory),
  ));
  if (!pathScore) return 0;
  const proximity = Math.max(0, DISCOVERY_FORWARD_MS - Math.abs(createdAt - evidenceAt));
  return pathScore * 1000000 + proximity;
}

function comparableText(value = "") {
  return normalizeText(value).replace(/[\s\\/"'“”‘’`*_>#：:，。,.；;（）()\[\]{}-]/g, "");
}

function concise(value = "", limit = 100) {
  const text = safeDisplayText(value, "").replace(/[`*_>#]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function conversationText(value = "", limit = 2400) {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const text = safeDisplayText(raw, "内容编码异常")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function conversationEntry(row) {
  const part = parseJson(row.data);
  const message = parseJson(row.message_data);
  const role = String(message.role || "assistant");
  const timestamp = Number(part.time?.start || part.time?.created || row.time_created || row.time_updated) || 0;
  if (part.type === "text") {
    const text = conversationText(part.text);
    return text ? { id: row.id, role, type: "message", label: role === "user" ? "任务" : "回复", text, timestamp } : null;
  }
  if (part.type === "reasoning") {
    const text = conversationText(part.text);
    return text ? { id: row.id, role: "assistant", type: "reasoning", label: "分析", text, timestamp } : null;
  }
  if (part.type === "tool") {
    const tool = concise(part.tool || part.name || "工具", 40);
    const state = part.state || {};
    const title = conversationText(state.title || state.input?.description || "", 320);
    const output = conversationText(state.output ?? state.result ?? "", 1800);
    const text = [title, output].filter(Boolean).join("\n");
    return {
      id: row.id,
      role: "tool",
      type: "tool",
      label: `工具 · ${tool}`,
      text: text || "工具调用",
      status: String(state.status || state.state || ""),
      timestamp,
    };
  }
  return null;
}

function partActivity(part = {}) {
  if (part.type === "tool") {
    const toolName = part.tool || part.name || "工具";
    const title = concise(part.state?.title || part.state?.input?.description || "", 72);
    return { stage: "tool", latestUpdate: title ? `正在执行 ${toolName} · ${title}` : `正在执行 ${toolName}` };
  }
  if (part.type === "reasoning") {
    return { stage: "thinking", latestUpdate: concise(part.text, 100) || "OpenCode 正在分析" };
  }
  if (part.type === "text") {
    return { stage: "reply", latestUpdate: concise(part.text, 100) || "OpenCode 已生成回复" };
  }
  if (part.type === "step-start") return { stage: "working", latestUpdate: "OpenCode 正在处理" };
  return null;
}

function scoreSession(delegation, session, userParts) {
  const target = normalizeText(delegation.prompt);
  const comparableTarget = comparableText(delegation.prompt);
  const directoryMatch = normalizePath(delegation.directory) === normalizePath(session.directory);
  let bestPrompt = 0;
  for (const row of userParts) {
    const rawText = parseJson(row.data).text;
    const text = normalizeText(rawText);
    if (!target || !text) continue;
    if (text === target) bestPrompt = Math.max(bestPrompt, 140);
    else if (text.includes(target) || target.includes(text)) bestPrompt = Math.max(bestPrompt, 105);
    else if (text.slice(0, 180) === target.slice(0, 180)) bestPrompt = Math.max(bestPrompt, 80);
    else if (comparableText(rawText).slice(0, 140) === comparableTarget.slice(0, 140)) bestPrompt = Math.max(bestPrompt, 115);
  }
  const activityAt = Math.max(Number(session.time_created) || 0, Number(session.time_updated) || 0);
  const distance = Math.abs(activityAt - Number(delegation.startedAt || 0));
  return bestPrompt + (directoryMatch ? 35 : 0) + Math.max(0, 20 - Math.floor(distance / 5000));
}

function collapseDelegations(delegations = []) {
  const result = [];
  const bySession = new Map();
  for (const delegation of delegations) {
    if (!delegation.sessionId || !bySession.has(delegation.sessionId)) {
      const copy = { ...delegation, rounds: 1 };
      result.push(copy);
      if (copy.sessionId) bySession.set(copy.sessionId, copy);
      continue;
    }
    const existing = bySession.get(delegation.sessionId);
    existing.callIds = [...new Set([...(existing.callIds || []), ...(delegation.callIds || [])])];
    existing.startedAt = Math.min(existing.startedAt || Infinity, delegation.startedAt || Infinity);
    existing.lastEventAt = Math.max(existing.lastEventAt || 0, delegation.lastEventAt || 0);
    existing.completedAt = Math.max(existing.completedAt || 0, delegation.completedAt || 0);
    existing.rounds += 1;
  }
  return result;
}

class OpenCodeMonitor {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
    this.db = null;
    this.matchCache = new Map();
  }

  open() {
    if (this.db || !DatabaseSync || !fs.existsSync(this.dbPath)) return Boolean(this.db);
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 180 });
      this.db.exec("PRAGMA query_only = ON");
      return true;
    } catch {
      this.db = null;
      return false;
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {}
    this.db = null;
  }

  userParts(sessionId, startedAt) {
    return this.db.prepare(
      `SELECT p.data, p.time_created
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text'
         AND p.time_created BETWEEN ? AND ?
       ORDER BY p.time_created DESC
       LIMIT 6`,
    ).all(sessionId, startedAt - SESSION_MATCH_WINDOW_MS, startedAt + SESSION_MATCH_WINDOW_MS);
  }

  matchSession(delegation) {
    if (delegation.sessionId) return delegation.sessionId;
    if (this.matchCache.has(delegation.id)) return this.matchCache.get(delegation.id);
    const startedAt = Number(delegation.startedAt) || Date.now();
    const sessions = this.db.prepare(
      `SELECT id, title, directory, time_created, time_updated
       FROM session
       WHERE time_updated >= ?
         AND time_created <= ?
       ORDER BY time_updated DESC
       LIMIT 40`,
    ).all(startedAt - SESSION_MATCH_WINDOW_MS, startedAt + SESSION_MATCH_WINDOW_MS);
    const ranked = sessions.map((session) => ({
      session,
      score: scoreSession(delegation, session, this.userParts(session.id, startedAt)),
    })).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.score >= 90 ? ranked[0].session.id : "";
    if (match) this.matchCache.set(delegation.id, match);
    return match;
  }

  firstUserPrompt(sessionId) {
    const row = this.db.prepare(
      `SELECT p.data
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
         AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text'
       ORDER BY p.time_created ASC
       LIMIT 1`,
    ).get(sessionId);
    return row ? concise(parseJson(row.data).text || "", 180) : "";
  }

  discoverSessions(tasks = [], linkedSessionIds = new Set()) {
    const eligible = tasks.filter((task) =>
      Number(task.openCodeHintAt) > 0 || (task.delegations || []).length > 0,
    );
    if (!eligible.length) return new Map();
    const earliest = Math.min(...eligible.map((task) =>
      Number(task.openCodeHintAt || task.startedAt) || Date.now(),
    )) - DISCOVERY_LOOKBACK_MS;
    const sessions = this.db.prepare(
      `SELECT id, title, directory, time_created, time_updated
       FROM session
       WHERE time_created >= ?
       ORDER BY time_created DESC
       LIMIT ?`,
    ).all(earliest, DISCOVERY_LIMIT);
    const discovered = new Map(eligible.map((task) => [task, []]));
    for (const session of sessions) {
      if (linkedSessionIds.has(session.id)) continue;
      const ranked = eligible.map((task) => ({ task, score: discoveryTaskScore(task, session) }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      const owner = ranked[0]?.task;
      if (!owner) continue;
      const detail = this.sessionState(session.id);
      if (!detail) continue;
      discovered.get(owner).push({
        id: `discovered:${session.id}`,
        sessionId: session.id,
        sessionTitle: detail.sessionTitle || concise(session.title || "", 80),
        provider: "OpenCode",
        prompt: this.firstUserPrompt(session.id) || detail.sessionTitle || "OpenCode subtask",
        directory: session.directory || owner.openCodeHintDirectory || owner.workspace || "",
        startedAt: Number(session.time_created) || 0,
        discovered: true,
        ...detail,
      });
      linkedSessionIds.add(session.id);
    }
    return discovered;
  }

  sessionState(sessionId) {
    const session = this.db.prepare(
      `SELECT id, title, model, time_created, time_updated,
              tokens_input, tokens_output, tokens_reasoning, cost
       FROM session WHERE id = ? LIMIT 1`,
    ).get(sessionId);
    if (!session) return null;
    const latestUser = this.db.prepare(
      `SELECT id, time_created
       FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') = 'user'
       ORDER BY time_created DESC
       LIMIT 1`,
    ).get(sessionId);
    const latestAssistant = this.db.prepare(
      `SELECT id, time_created, time_updated, data
       FROM message
       WHERE session_id = ?
         AND json_extract(data, '$.role') = 'assistant'
       ORDER BY time_created DESC
       LIMIT 1`,
    ).get(sessionId);
    const currentAssistant = latestAssistant
      && Number(latestAssistant.time_created) >= Number(latestUser?.time_created || 0)
      ? latestAssistant
      : null;
    const currentParts = currentAssistant ? this.db.prepare(
      `SELECT data, time_updated
       FROM part
       WHERE session_id = ?
         AND message_id = ?
       ORDER BY time_updated DESC
       LIMIT 16`,
    ).all(sessionId, currentAssistant.id) : [];
    const latestTextRow = this.db.prepare(
      `SELECT p.data
       FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
         AND json_extract(m.data, '$.role') = 'assistant'
         AND json_extract(p.data, '$.type') = 'text'
       ORDER BY p.time_updated DESC
       LIMIT 1`,
    ).get(sessionId);
    const latestText = latestTextRow ? parseJson(latestTextRow.data) : null;
    const activity = currentParts
      .map((row) => parseJson(row.data))
      .map(partActivity)
      .find(Boolean) || { stage: "working", latestUpdate: "OpenCode 正在处理" };
    const message = parseJson(currentAssistant?.data);
    const completedAt = Number(message.time?.completed) || 0;
    const failed = Boolean(message.error) || ["error", "cancelled"].includes(String(message.finish || "").toLowerCase());
    const waitingForAssistant = !currentAssistant;
    const status = failed ? "failed" : completedAt && !waitingForAssistant ? "completed" : "running";
    const latestUpdate = failed
      ? "OpenCode 子任务异常结束"
      : status === "completed"
        ? latestText?.text
          ? concise(latestText.text, 100)
          : "OpenCode 已完成"
        : waitingForAssistant
          ? "等待 OpenCode 响应"
          : activity.latestUpdate;
    return {
      sessionId,
      sessionTitle: concise(session.title || "", 80),
      stage: failed ? "failed" : status === "completed" ? "completed" : waitingForAssistant ? "starting" : activity.stage,
      status,
      latestUpdate,
      latestReply: concise(latestText?.text || "", 160),
      lastEventAt: Number(session.time_updated) || 0,
      completedAt,
      tokens: {
        input: Number(session.tokens_input) || 0,
        output: Number(session.tokens_output) || 0,
        reasoning: Number(session.tokens_reasoning) || 0,
      },
      cost: Number(session.cost) || 0,
      model: parseJson(session.model, session.model || "")?.id || session.model || "",
    };
  }

  getConversation(sessionId, options = {}) {
    const id = String(sessionId || "");
    if (!/^ses_[A-Za-z0-9_-]+$/.test(id) || !this.open()) {
      return { available: false, sessionId: id, entries: [], error: "OpenCode 会话不可用" };
    }
    try {
      const session = this.db.prepare(
        `SELECT id, title, directory, time_created, time_updated
         FROM session WHERE id = ? LIMIT 1`,
      ).get(id);
      if (!session) return { available: false, sessionId: id, entries: [], error: "未找到 OpenCode 会话" };
      const requested = Math.max(20, Math.min(500, Number(options.limit) || CONVERSATION_ENTRY_LIMIT));
      const rows = this.db.prepare(
        `SELECT p.id, p.data, p.time_created, p.time_updated, m.data AS message_data
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ?
           AND json_extract(p.data, '$.type') IN ('text', 'reasoning', 'tool')
         ORDER BY p.time_created DESC, p.time_updated DESC
         LIMIT ?`,
      ).all(id, requested + 1);
      const truncated = rows.length > requested;
      const entries = rows.slice(0, requested).reverse().map(conversationEntry).filter(Boolean);
      const state = this.sessionState(id);
      return {
        available: true,
        sessionId: id,
        title: concise(session.title || "OpenCode 子任务", 100),
        directory: conversationText(session.directory || "", 300),
        startedAt: Number(session.time_created) || 0,
        updatedAt: Number(session.time_updated) || 0,
        status: state?.status || "unknown",
        stage: state?.stage || "working",
        truncated,
        entries,
      };
    } catch {
      return { available: false, sessionId: id, entries: [], error: "读取 OpenCode 历史失败" };
    }
  }

  enrichTasks(tasks = []) {
    const hasEvidence = tasks.some((task) => task.delegations?.length || Number(task.openCodeHintAt) > 0);
    if (!hasEvidence || !this.open()) return tasks;
    const linkedSessionIds = new Set();
    const enrichedTasks = tasks.map((task) => {
      const enriched = (task.delegations || []).map((delegation) => {
        try {
          const sessionId = this.matchSession(delegation);
          const detail = sessionId ? this.sessionState(sessionId) : null;
          if (!detail) return delegation;
          linkedSessionIds.add(sessionId);
          const terminalFinal = delegation.status !== "running"
            && Number(delegation.completedAt || 0) >= Number(detail.lastEventAt || 0);
          if (!terminalFinal) return { ...delegation, ...detail };
          return {
            ...delegation,
            ...detail,
            status: delegation.status,
            stage: delegation.status,
            completedAt: delegation.completedAt,
            lastEventAt: Math.max(delegation.lastEventAt || 0, detail.lastEventAt || 0),
            latestUpdate: delegation.status === "failed"
              ? "OpenCode 子任务已中断"
              : detail.latestReply || "OpenCode 已完成",
          };
        } catch {
          return delegation;
        }
      });
      return { ...task, delegations: collapseDelegations(enriched) };
    });
    const discoveredByTask = this.discoverSessions(enrichedTasks, linkedSessionIds);
    return enrichedTasks.map((task) => ({
      ...task,
      delegations: collapseDelegations([
        ...(task.delegations || []),
        ...(discoveredByTask.get(task) || []),
      ]),
    }));
  }
}

module.exports = {
  OpenCodeMonitor,
  concise,
  collapseDelegations,
  comparableText,
  conversationEntry,
  conversationText,
  directoryRelationScore,
  discoveryTaskScore,
  normalizePath,
  normalizeText,
  partActivity,
  scoreSession,
};
