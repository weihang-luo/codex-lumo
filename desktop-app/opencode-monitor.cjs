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

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

function normalizePath(value = "") {
  return String(value).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function comparableText(value = "") {
  return normalizeText(value).replace(/[\\/"'“”‘’`*_>#：:，。,.；;（）()\[\]{}-]/g, "");
}

function concise(value = "", limit = 100) {
  const text = safeDisplayText(value, "").replace(/[`*_>#]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
    const text = normalizeText(parseJson(row.data).text);
    if (!target || !text) continue;
    if (text === target) bestPrompt = Math.max(bestPrompt, 140);
    else if (text.includes(target) || target.includes(text)) bestPrompt = Math.max(bestPrompt, 105);
    else if (text.slice(0, 180) === target.slice(0, 180)) bestPrompt = Math.max(bestPrompt, 80);
    else if (comparableText(text).slice(0, 140) === comparableTarget.slice(0, 140)) bestPrompt = Math.max(bestPrompt, 115);
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

  enrichTasks(tasks = []) {
    if (!tasks.some((task) => task.delegations?.length) || !this.open()) return tasks;
    return tasks.map((task) => {
      const enriched = (task.delegations || []).map((delegation) => {
        try {
          const sessionId = this.matchSession(delegation);
          const detail = sessionId ? this.sessionState(sessionId) : null;
          if (!detail) return delegation;
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
  }
}

module.exports = {
  OpenCodeMonitor,
  concise,
  collapseDelegations,
  comparableText,
  normalizePath,
  normalizeText,
  partActivity,
  scoreSession,
};
