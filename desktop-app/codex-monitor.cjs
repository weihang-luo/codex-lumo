const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { OpenCodeMonitor } = require("./opencode-monitor.cjs");
const { safeDisplayText } = require("./text-quality.cjs");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  // JSONL monitoring remains available on older Electron runtimes.
}

const MAX_EVENT_HISTORY = 5;
const MAX_RECONSTRUCT_BYTES = 2 * 1024 * 1024;
const TASK_SCAN_CHUNK_BYTES = 512 * 1024;
const QUOTA_SCAN_BYTES = 1024 * 1024;
const TASK_START_NEEDLE = Buffer.from('"type":"task_started"');
const RUNNING_TASK_STALE_MS = 12 * 60 * 60 * 1000;
const START_ONLY_TASK_STALE_MS = 5 * 60 * 1000;
const THINKING_STAGES = Object.freeze([
  "正在理解上下文",
  "正在拆解任务",
  "正在评估实现路径",
  "正在规划下一步",
]);

function thinkingStage(step = 0) {
  const index = Math.max(0, Number(step) || 0) % THINKING_STAGES.length;
  return THINKING_STAGES[index];
}

function stripInjectedContext(text = "") {
  let value = String(text);
  value = value.replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, " ");
  value = value.replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ");
  value = value.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ");
  value = value.replace(/<[^>]+>/g, " ");
  const marker = value.match(/##\s*My request for Codex:\s*([\s\S]*)/i);
  if (marker) value = marker[1];
  return safeDisplayText(value.replace(/\s+/g, " ").trim(), "");
}

function shortTaskTitle(text, fallback = "正在处理 Codex 任务") {
  const clean = stripInjectedContext(text);
  if (!clean) return fallback;
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

function shortReply(text, fallback = "Codex 发来新回复") {
  const clean = stripInjectedContext(text);
  if (!clean) return fallback;
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

function extractMessageText(payload) {
  if (!Array.isArray(payload?.content)) return "";
  return payload.content
    .filter((item) => item?.type === "input_text" || item?.type === "text")
    .map((item) => item.text || item.input_text || "")
    .join(" ");
}

function decodeCommandLiteral(token = "") {
  const quote = token[0];
  const body = token.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(token);
    } catch {}
  }
  return body
    .replace(/\\\\r\\\\n/g, "\n")
    .replace(/\\\\n/g, "\n")
    .replace(/\\\\r/g, "\n")
    .replace(/\\\\t/g, "\t")
    .replace(/\\\\([\\\\`'\"])/g, "$1");
}

function customCommandBodies(source = "") {
  const bodies = [];
  const call = /\btools\.(?:shell_command|exec_command)\s*\(\s*\{/g;
  let match;
  while ((match = call.exec(String(source)))) {
    const start = call.lastIndex - 1;
    let depth = 1;
    let index = start + 1;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "'" || char === '"' || char === "`") {
        const quote = char;
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      index += 1;
    }
    if (depth === 0) bodies.push(source.slice(start + 1, index - 1));
    call.lastIndex = index;
  }
  return bodies;
}

function dynamicOpenCodeCommands(payload = {}) {
  if (payload.type !== "custom_tool_call") return [];
  const input = String(payload.input || "");
  const bodies = customCommandBodies(input);
  const hasDynamicCommand = bodies.some((body) => /\b(?:cmd|command)\s*:\s*[A-Za-z_$][\w.$[\]]*/.test(body));
  if (!hasDynamicCommand) return [];
  const commands = [];
  const literal = /(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  let match;
  while ((match = literal.exec(input))) {
    const value = decodeJavaScriptString(match[1]).trim();
    if (/^(?:&\s*)?(?:[\w.-]+\s+exec\s+)?opencode(?:\.cmd|\.ps1|\.exe)?\s+run\b/i.test(value)) {
      commands.push(value);
    }
  }
  return [...new Set(commands)];
}

function commandSegmentsFromToolCall(payload = {}) {
  if (payload.type === "function_call") {
    try {
      const args = typeof payload.arguments === "string"
        ? JSON.parse(payload.arguments)
        : payload.arguments;
      return [args?.command, args?.cmd].filter((value) => typeof value === "string");
    } catch {
      return [];
    }
  }
  if (payload.type !== "custom_tool_call") return [];
  const input = String(payload.input || "");
  const segments = [];
  const pattern = /\b(?:cmd|command)\s*:\s*(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const body of customCommandBodies(input)) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(body))) segments.push(decodeCommandLiteral(match[1]));
  }
  if (!segments.length) segments.push(...dynamicOpenCodeCommands(payload));
  return segments;
}

function decodeJavaScriptString(token = "") {
  if (!token || token.length < 2) return "";
  const quote = token[0];
  if (quote === '"') {
    try {
      return JSON.parse(token);
    } catch {}
  }
  return token.slice(1, -1)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\([\\`'"$])/g, "$1");
}

function javascriptPromptArrays(source = "") {
  const arrays = new Map();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\[/g;
  let match;
  while ((match = declaration.exec(String(source)))) {
    const values = [];
    let depth = 1;
    let index = declaration.lastIndex;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "'" || char === '"' || char === "`") {
        const start = index;
        const quote = char;
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            index += 1;
            break;
          }
          index += 1;
        }
        if (depth === 1) values.push(decodeJavaScriptString(source.slice(start, index)));
        continue;
      }
      if (char === "[") depth += 1;
      if (char === "]") depth -= 1;
      index += 1;
    }
    if (values.length) arrays.set(match[1], values.filter((value) => value.trim()));
    declaration.lastIndex = index;
  }
  return arrays;
}

function javascriptPromptVariables(source = "") {
  const variables = new Map();
  const assignment = /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;?/g;
  let match;
  while ((match = assignment.exec(String(source)))) {
    const value = decodeJavaScriptString(match[2]).trim();
    if (value) variables.set(match[1], value);
  }
  return variables;
}

function dynamicPromptValues(payload = {}, command = "") {
  const expression = command.match(/\$\{\s*JSON\.stringify\(\s*([A-Za-z_]\w*)\s*\)\s*\}/);
  if (!expression || payload.type !== "custom_tool_call") return [];
  const source = String(payload.input || "");
  const variables = javascriptPromptVariables(source);
  if (variables.has(expression[1])) return [variables.get(expression[1])];
  const arrays = javascriptPromptArrays(source);
  const iterator = expression[1];
  const mapping = String(payload.input || "").match(
    new RegExp(`\\b([A-Za-z_]\\w*)\\.map\\(\\s*\\(?\\s*${iterator}\\s*\\)?\\s*=>`),
  );
  if (mapping && arrays.has(mapping[1])) return arrays.get(mapping[1]);
  return arrays.size === 1 ? [...arrays.values()][0] : [];
}

function toolCallDirectory(payload = {}) {
  if (payload.type === "function_call") {
    try {
      const args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
      return typeof args?.workdir === "string" ? args.workdir : "";
    } catch {
      return "";
    }
  }
  const bodies = customCommandBodies(String(payload.input || ""));
  const match = bodies.join("\n").match(/\bworkdir\s*:\s*(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
  return match ? decodeCommandLiteral(match[1]) : "";
}

function hasOpenCodeLaunchHint(event) {
  const payload = event?.payload || {};
  if (!["function_call", "custom_tool_call"].includes(eventType(event))) return false;
  if (payload.type === "function_call") {
    return commandSegmentsFromToolCall(payload)
      .some((command) => /\bopencode(?:\.cmd|\.ps1|\.exe)?\s+run\b/i.test(command));
  }
  const input = String(payload.input || "");
  return customCommandBodies(input).length > 0
    && /\bopencode(?:\.cmd|\.ps1|\.exe)?\s+run\b/i.test(input);
}

function powershellPromptVariables(command = "") {
  const prompts = new Map();
  const patterns = [
    /\$([A-Za-z_]\w*)\s*=\s*@'\s*\r?\n([\s\S]*?)\r?\n'@/g,
    /\$([A-Za-z_]\w*)\s*=\s*@"\s*\r?\n([\s\S]*?)\r?\n"@/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(command))) prompts.set(match[1], match[2].trim());
  }
  return prompts;
}

function openCodeModel(commandLine = "") {
  const match = commandLine.match(/(?:--model|-m)\s+(?:['"]([^'"]+)['"]|([^\s;]+))/i);
  return (match?.[1] || match?.[2] || "OpenCode default").trim();
}

function openCodeDirectory(commandLine = "") {
  const match = commandLine.match(/--dir(?:=|\s+)(?:['"]([^'"]+)['"]|([^\s;]+))/i);
  return (match?.[1] || match?.[2] || "").trim();
}

function delegatedTaskTitle(prompt = "") {
  if (/^\s*\$\{[\s\S]+\}\s*$/.test(String(prompt)) || /JSON\.stringify\s*\(/.test(String(prompt))) {
    return "OpenCode 子任务";
  }
  let value = String(prompt)
    .replace(/[A-Za-z]:\\[^\s，。；]+/g, "当前工作区")
    .replace(/\s+/g, " ")
    .trim();
  const explicit = value.match(/(?:子任务|任务)\s*[：:]\s*([^。；\n]+)/);
  if (explicit?.[1]) value = explicit[1].trim();
  return shortTaskTitle(value, "OpenCode 子任务");
}

function stripOpenCodeOptions(value = "") {
  return String(value)
    .replace(/(?:--(?:model|variant|log-level|command|session|agent|format|file|title|attach|password|username|dir|port)|-[msfpu])(?:=|\s+)(?:'[^']+'|"[^"]+"|\S+)/gi, " ")
    .replace(/(?:--(?:auto|continue|fork|share|print-logs|pure|thinking|interactive)|-[ci])\b/gi, " ")
    .replace(/^\s*--\s*/, " ")
    .trim();
}

function extractOpenCodeInvocations(event) {
  const payload = event?.payload || {};
  const type = eventType(event);
  if (type !== "function_call" && type !== "custom_tool_call") return [];
  const callId = String(payload.call_id || payload.id || "");
  const directory = toolCallDirectory(payload);
  const invocations = [];

  for (const command of commandSegmentsFromToolCall(payload)) {
    const prompts = powershellPromptVariables(command);
    const hereStringRanges = [];
    for (const pattern of [/@'[\s\S]*?'@/g, /@"[\s\S]*?"@/g]) {
      let range;
      while ((range = pattern.exec(command))) hereStringRanges.push([range.index, range.index + range[0].length]);
    }
    const invocation = /(?:^|[;\r\n]|&&|\|\|)\s*(?:\$[A-Za-z_]\w*\s*=\s*)?&?\s*(?:(?:npx|pnpx|bunx|yarn\s+dlx|pnpm\s+(?:dlx|exec)|npm\s+exec(?:\s+--)?)\s+)?(?:[A-Za-z]:[^\r\n;]*?[\\/])?opencode(?:\.cmd|\.ps1|\.exe)?\s+run\b([^\r\n;]*)/gi;
    let match;
    while ((match = invocation.exec(command))) {
      if (hereStringRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const tail = match[1] || "";
      if (/^\s*--help\b/i.test(tail)) continue;
      const dynamicPrompts = dynamicPromptValues(payload, command);
      const references = [...tail.matchAll(/\$([A-Za-z_]\w*)/g)];
      const variable = references.length ? references.at(-1)[1] : "";
      let prompt = prompts.get(variable) || "";
      if (!prompt) {
        prompt = stripOpenCodeOptions(tail)
          .replace(/^['"`]|['"`]$/g, "")
          .trim();
      }
      const resolvedPrompts = dynamicPrompts.length ? dynamicPrompts : [prompt];
      for (const resolvedPrompt of resolvedPrompts) {
        invocations.push({
          id: `${callId || "opencode"}:${invocations.length}`,
          callIds: callId ? [callId] : [],
          transportId: "",
          provider: "OpenCode",
          model: openCodeModel(tail),
          title: delegatedTaskTitle(resolvedPrompt),
          prompt: resolvedPrompt,
          directory: openCodeDirectory(tail) || directory,
          sessionId: "",
          stage: "starting",
          latestUpdate: "正在启动 OpenCode",
          tokens: null,
          status: "running",
          startedAt: Date.parse(event?.timestamp || "") || Date.now(),
          completedAt: 0,
          lastEventAt: Date.parse(event?.timestamp || "") || Date.now(),
        });
      }
    }
  }
  return invocations;
}

function toolOutputText(payload = {}) {
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) {
    return payload.output
      .map((item) => item?.text || item?.input_text || "")
      .filter(Boolean)
      .join("\n");
  }
  return payload.output == null ? "" : JSON.stringify(payload.output);
}

function transportIdsFromText(text = "") {
  const ids = new Set();
  for (const pattern of [
    /Script running with cell ID\s+([^\s"'}]+)/gi,
    /["']?(?:session_id|cell_id)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/gi,
  ]) {
    let match;
    while ((match = pattern.exec(String(text)))) ids.add(match[1]);
  }
  return [...ids];
}

function toolCallTransportIds(payload = {}) {
  const text = payload.type === "function_call"
    ? String(payload.arguments || "")
    : String(payload.input || "");
  return transportIdsFromText(text);
}

function advanceDelegations(task, event) {
  task.delegations = Array.isArray(task.delegations) ? task.delegations : [];
  const payload = event?.payload || {};
  const type = eventType(event);
  const timestamp = Date.parse(event?.timestamp || "") || task.lastEventAt || Date.now();
  const callId = String(payload.call_id || payload.id || "");
  if (hasOpenCodeLaunchHint(event)) {
    task.openCodeHintAt = timestamp;
    task.openCodeHintDirectory = toolCallDirectory(payload) || task.openCodeHintDirectory || task.workspace || "";
  }
  const created = extractOpenCodeInvocations(event);
  if (created.length) {
    const existing = new Set(task.delegations.map((item) => item.id));
    task.delegations.push(...created.filter((item) => !existing.has(item.id)));
  }

  if ((type === "function_call" || type === "custom_tool_call") && !created.length) {
    const transportIds = toolCallTransportIds(payload);
    if (transportIds.length && callId) {
      for (const delegation of task.delegations) {
        if (!transportIds.includes(String(delegation.transportId || ""))) continue;
        delegation.callIds = [...new Set([...(delegation.callIds || []), callId])];
        delegation.status = "running";
        delegation.lastEventAt = timestamp;
      }
    }
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = toolOutputText(payload);
    const transports = transportIdsFromText(output);
    const running = transports.length > 0 || /script running|process is still running|session is still running/i.test(output);
    const failed = payload.isError === true
      || /Exit code:\s*[1-9]|Process exited with code\s+[1-9]|"exit_code"\s*:\s*[1-9]/i.test(output);
    const linked = task.delegations.filter((delegation) => (delegation.callIds || []).includes(callId));
    for (const [index, delegation] of linked.entries()) {
      delegation.lastEventAt = timestamp;
      if (running) {
        delegation.status = "running";
        delegation.transportId = transports[index]
          || (linked.length === 1 ? transports[0] : "")
          || delegation.transportId;
      } else {
        delegation.status = failed ? "failed" : "completed";
        delegation.completedAt = timestamp;
      }
    }
  }

  return {
    created: created.length,
    running: task.delegations.filter((item) => item.status === "running").length,
    failed: task.delegations.filter((item) => item.status === "failed").length,
  };
}

function alignTaskWithDelegations(task) {
  const running = (task?.delegations || [])
    .filter((delegation) => delegation.status === "running")
    .sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0));
  if (!running.length) return task;
  const current = running[0];
  return {
    ...task,
    mode: "working",
    phase: "执行中",
    detail: `OpenCode · ${safeDisplayText(current.latestUpdate, "子任务运行中") || "子任务运行中"}`,
  };
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath || "").match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match ? match[1] : "";
}

function labelForTool(name = "") {
  const tool = String(name).toLowerCase();
  if (/apply_patch|edit|write/.test(tool)) return "正在修改文件";
  if (/shell|exec|command|terminal/.test(tool)) return "正在运行命令";
  if (/image|render/.test(tool)) return "正在生成视觉";
  if (/web|search|browser|fetch/.test(tool)) return "正在查找资料";
  if (/wait/.test(tool)) return "等待后台任务";
  if (/deploy|site|publish/.test(tool)) return "正在发布成果";
  if (/test|lint/.test(tool)) return "正在验证结果";
  return "正在调用工具";
}

function eventSummary(event) {
  const outer = event?.type;
  const inner = event?.payload?.type;
  if (inner === "task_started") return "收到新任务";
  if (inner === "agent_reasoning") return "分析任务";
  if (inner === "agent_message") return "Codex 发来回复";
  if (inner === "custom_tool_call" || inner === "function_call") {
    if (extractOpenCodeInvocations(event).length) return "已委派 OpenCode 子任务";
    return labelForTool(event.payload.name);
  }
  if (inner === "custom_tool_call_output" || inner === "function_call_output") {
    return "工具返回结果";
  }
  if (inner === "patch_apply_end") return "文件修改完成";
  if (inner === "mcp_tool_call_end") return "连接器返回结果";
  if (inner === "task_complete" || inner === "turn_complete" || inner === "turn_completed") {
    return "任务已完成";
  }
  if (outer === "session_meta") return "已连接 Codex";
  return "";
}

function parseJsonLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial first or last line is expected while tailing a live file.
    }
  }
  return events;
}

function eventType(event) {
  return event?.payload?.type || event?.type || "";
}

function quotaFromRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const windows = [
    ["primary", rateLimits.primary],
    ["secondary", rateLimits.secondary],
  ]
    .filter(([, value]) => value && Number.isFinite(Number(value.used_percent)))
    .map(([kind, value]) => {
      const usedPercent = Math.max(0, Math.min(100, Number(value.used_percent)));
      return {
        kind,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        windowMinutes: Math.max(0, Number(value.window_minutes) || 0),
        resetsAt: Math.max(0, Number(value.resets_at) || 0),
      };
    });
  const unlimited = Boolean(rateLimits.credits?.unlimited);
  if (!windows.length && !unlimited) return null;
  const current = windows.sort((a, b) => a.remainingPercent - b.remainingPercent)[0] || {
    kind: "credits",
    usedPercent: 0,
    remainingPercent: 100,
    windowMinutes: 0,
    resetsAt: 0,
  };
  return {
    available: true,
    ...current,
    unlimited,
    limitId: String(rateLimits.limit_id || "codex"),
    limitName: String(rateLimits.limit_name || "Codex"),
    planType: String(rateLimits.plan_type || ""),
    creditsBalance: rateLimits.credits?.balance ?? null,
    windows,
  };
}

function rateLimitRecordsFromEvents(events) {
  const latestByLimit = new Map();
  for (const event of events) {
    const rateLimits = event?.payload?.type === "token_count" ? event.payload.rate_limits : null;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const observedAt = Date.parse(event?.timestamp || "") || 0;
    const limitId = String(rateLimits.limit_id || "codex");
    const previous = latestByLimit.get(limitId);
    if (!previous || observedAt >= previous.observedAt) {
      latestByLimit.set(limitId, { rateLimits, observedAt });
    }
  }
  return [...latestByLimit.values()];
}

function quotaFromRateLimitRecords(records, now = Date.now()) {
  const latestByLimit = new Map();
  for (const record of records || []) {
    const rateLimits = record?.rateLimits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const limitId = String(rateLimits.limit_id || "codex");
    const observedAt = Math.max(0, Number(record.observedAt) || 0);
    const previous = latestByLimit.get(limitId);
    if (!previous || observedAt >= previous.observedAt) {
      latestByLimit.set(limitId, { rateLimits, observedAt });
    }
  }

  const quotas = [];
  for (const { rateLimits, observedAt } of latestByLimit.values()) {
    const activeRateLimits = { ...rateLimits };
    for (const kind of ["primary", "secondary"]) {
      const window = rateLimits[kind];
      const resetsAt = Math.max(0, Number(window?.resets_at) || 0) * 1000;
      if (window && resetsAt && resetsAt <= now && observedAt < resetsAt) {
        activeRateLimits[kind] = null;
      }
    }
    const quota = quotaFromRateLimits(activeRateLimits);
    if (quota) quotas.push({ ...quota, observedAt });
  }

  return quotas.sort((a, b) => {
    const pressure = a.remainingPercent - b.remainingPercent;
    if (pressure) return pressure;
    if (a.limitId === "codex" && b.limitId !== "codex") return -1;
    if (b.limitId === "codex" && a.limitId !== "codex") return 1;
    return b.observedAt - a.observedAt;
  })[0] || null;
}

function taskSummaryFromEvents(events, options = {}) {
  const lastStart = events.map(eventType).lastIndexOf("task_started");
  if (lastStart < 0) return null;

  const startedEvent = events[lastStart];
  const startedAt = Date.parse(startedEvent?.timestamp || "") || options.mtimeMs || Date.now();
  const task = {
    id: options.threadId || "",
    task: "正在处理 Codex 任务",
    mode: "thinking",
    phase: "思考中",
    detail: "正在理解任务",
    progress: 8,
    startedAt,
    lastEventAt: startedAt,
    workspace: options.workspace || "",
    thinkingStep: 0,
    latestReply: "",
    replyAt: 0,
    delegations: [],
    openCodeHintAt: 0,
    openCodeHintDirectory: "",
  };

  return advanceTaskSummary(task, events.slice(lastStart + 1));
}

function advanceTaskSummary(task, events) {
  for (const event of events) {
    const payload = event?.payload || {};
    const type = eventType(event);
    const timestamp = Date.parse(event?.timestamp || "") || task.lastEventAt;
    task.lastEventAt = Math.max(task.lastEventAt, timestamp);
    const delegationUpdate = advanceDelegations(task, event);
    const linkedDelegation = task.delegations.some((delegation) =>
      (delegation.callIds || []).includes(String(payload.call_id || payload.id || "")),
    );

    if (type === "task_complete" || type === "turn_complete" || type === "turn_completed" || type === "turn_aborted") {
      return null;
    }
    if (event.type === "session_meta") {
      task.workspace = payload.cwd || task.workspace;
    } else if (type === "agent_message") {
      const latestReply = shortReply(payload.message);
      task.mode = "reply";
      task.phase = "有新回复";
      task.detail = latestReply;
      task.latestReply = latestReply;
      task.replyAt = timestamp;
    } else if (type === "message" && payload.role === "user") {
      task.task = shortTaskTitle(extractMessageText(payload), task.task);
      task.mode = "thinking";
      task.phase = "思考中";
      task.thinkingStep = 1;
      task.detail = thinkingStage(task.thinkingStep);
      task.progress = Math.max(task.progress, 12);
    } else if (type === "user_message") {
      task.task = shortTaskTitle(payload.message, task.task);
      task.mode = "thinking";
      task.phase = "思考中";
      task.thinkingStep = 1;
      task.detail = thinkingStage(task.thinkingStep);
      task.progress = Math.max(task.progress, 12);
    } else if (type === "agent_reasoning") {
      task.mode = "thinking";
      task.phase = "思考中";
      task.thinkingStep += 1;
      task.detail = thinkingStage(task.thinkingStep);
      task.progress = Math.min(88, Math.max(task.progress + 1, 16));
    } else if (type === "custom_tool_call" || type === "function_call") {
      const waiting = /wait/i.test(payload.name || "");
      task.mode = waiting ? "waiting" : "working";
      task.phase = waiting ? "等待中" : "执行中";
      task.detail = delegationUpdate.created
        ? `已委派 ${delegationUpdate.created} 个 OpenCode 子任务`
        : linkedDelegation
          ? "OpenCode 子任务运行中"
          : labelForTool(payload.name);
      task.progress = Math.min(92, Math.max(task.progress + 3, 24));
    } else if (type === "custom_tool_call_output" || type === "function_call_output") {
      const output = toolOutputText(payload);
      const failed = payload.isError === true
        || /Exit code:\s*[1-9]|Process exited with code\s+[1-9]|"exit_code"\s*:\s*[1-9]/i.test(output);
      task.mode = failed ? "error" : "working";
      task.phase = failed ? "调整中" : "执行中";
      task.detail = linkedDelegation
        ? delegationUpdate.failed
          ? "OpenCode 子任务异常，正在检查结果"
          : delegationUpdate.running
            ? "OpenCode 子任务仍在运行"
            : "OpenCode 子任务已返回结果"
        : failed
          ? "遇到问题，正在尝试其他方法"
          : "正在整理工具结果";
      task.progress = Math.min(94, Math.max(task.progress + 1, 28));
    }
  }

  return task;
}

function findLastTaskStartOffset(filePath, fileSize) {
  let cursor = Math.max(0, Number(fileSize) || 0);
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    while (cursor > 0) {
      const start = Math.max(0, cursor - TASK_SCAN_CHUNK_BYTES);
      const buffer = Buffer.alloc(cursor - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      const match = buffer.lastIndexOf(TASK_START_NEEDLE);
      if (match >= 0) {
        const newline = buffer.lastIndexOf(0x0a, match);
        return start + newline + 1;
      }
      if (start === 0) break;
      cursor = start + TASK_START_NEEDLE.length - 1;
    }
  } catch {
    return -1;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  return -1;
}

function readCompleteEvents(filePath, startOffset, fileSize) {
  const start = Math.max(0, Math.min(Number(startOffset) || 0, fileSize));
  if (start >= fileSize) return { events: [], nextOffset: start };
  let handle = null;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(fileSize - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { events: [], nextOffset: start };
    return {
      events: parseJsonLines(buffer.subarray(0, lastNewline + 1).toString("utf8")),
      nextOffset: start + lastNewline + 1,
    };
  } catch {
    return { events: [], nextOffset: start };
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

class CodexMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexRoot = options.codexRoot || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    this.sessionsRoot = path.join(this.codexRoot, "sessions");
    this.logsDbPath = path.join(this.codexRoot, "logs_2.sqlite");
    this.activeFile = "";
    this.activeOffset = 0;
    this.pollTimer = null;
    this.rescanTimer = null;
    this.started = false;
    this.powerSaving = false;
    this.foregroundPollMs = options.pollIntervalMs || 700;
    this.foregroundRescanMs = options.rescanIntervalMs || 2800;
    this.backgroundPollMs = options.backgroundPollMs || 2000;
    this.backgroundRescanMs = options.backgroundRescanMs || 10000;
    this.lastStateSignature = "";
    this.db = null;
    this.lastCompletionCheck = 0;
    this.taskCache = new Map();
    this.quotaFileCache = new Map();
    this.quotaRecords = new Map();
    this.runningTasks = [];
    this.openCode = new OpenCodeMonitor({ dbPath: options.openCodeDbPath });
    this.state = {
      connection: "searching",
      mode: "offline",
      phase: "等待 Codex",
      detail: "正在寻找本地任务",
      task: "等待下一项任务",
      progress: 0,
      elapsedSeconds: 0,
      startedAt: 0,
      lastEventAt: 0,
      threadId: "",
      workspace: "",
      source: "本地会话日志",
      events: [],
      tasks: [],
      delegations: [],
      openCodeHintAt: 0,
      openCodeHintDirectory: "",
      thinkingStep: 0,
      latestReply: "",
      replyAt: 0,
      replyFresh: false,
      quota: null,
    };
  }

  getOpenCodeConversation(sessionId) {
    const conversation = this.openCode.getConversation(sessionId);
    const delegation = this.runningTasks
      .flatMap((task) => task.delegations || [])
      .find((item) => item.sessionId === sessionId);
    if (!conversation.available || !delegation || delegation.status === "running") return conversation;
    if (Number(delegation.completedAt || 0) < Number(conversation.updatedAt || 0)) return conversation;
    return {
      ...conversation,
      status: delegation.status,
      stage: delegation.stage || delegation.status,
      completedAt: delegation.completedAt || 0,
    };
  }

  start() {
    this.openLogsDatabase();
    this.scanForActiveSession(true);
    this.started = true;
    this.scheduleTimers();
    return this;
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.rescanTimer);
    this.pollTimer = null;
    this.rescanTimer = null;
    this.started = false;
    if (this.db) {
      try {
        this.db.close();
      } catch {}
    }
    this.db = null;
    this.openCode.close();
  }

  scheduleTimers() {
    clearInterval(this.pollTimer);
    clearInterval(this.rescanTimer);
    const pollMs = this.powerSaving ? this.backgroundPollMs : this.foregroundPollMs;
    const rescanMs = this.powerSaving ? this.backgroundRescanMs : this.foregroundRescanMs;
    this.pollTimer = setInterval(() => this.poll(), pollMs);
    this.rescanTimer = setInterval(() => this.scanForActiveSession(false), rescanMs);
  }

  setPowerSave(enabled) {
    const next = Boolean(enabled);
    if (next === this.powerSaving) return this.powerSaving;
    this.powerSaving = next;
    if (this.started) {
      if (!next) {
        this.scanForActiveSession(false);
        this.poll();
      }
      this.scheduleTimers();
    }
    return this.powerSaving;
  }

  snapshot() {
    const elapsedSeconds = this.state.startedAt
      ? Math.max(0, Math.floor((Date.now() - this.state.startedAt) / 1000))
      : 0;
    const withElapsed = (delegation) => ({
      ...delegation,
      elapsedSeconds: delegation.startedAt
        ? Math.max(0, Math.floor(((delegation.completedAt || Date.now()) - delegation.startedAt) / 1000))
        : 0,
    });
    const tasks = (this.state.tasks || []).map((task) => ({
      ...task,
      elapsedSeconds: task.startedAt
        ? Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))
        : 0,
      delegations: (task.delegations || []).map(withElapsed),
    }));
    return {
      ...this.state,
      elapsedSeconds,
      delegations: (this.state.delegations || []).map(withElapsed),
      tasks,
    };
  }

  emitState(force = false) {
    const signature = JSON.stringify(this.state);
    if (!force && signature === this.lastStateSignature) return false;
    this.lastStateSignature = signature;
    this.emit("state", this.snapshot());
    return true;
  }

  openLogsDatabase() {
    if (!DatabaseSync || !fs.existsSync(this.logsDbPath)) return;
    try {
      this.db = new DatabaseSync(this.logsDbPath, { readOnly: true, timeout: 250 });
      this.db.exec("PRAGMA query_only = ON");
    } catch {
      this.db = null;
    }
  }

  listRecentSessionFiles() {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const files = [];
    const visit = (directory, depth = 0) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath, depth + 1);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const stat = fs.statSync(fullPath);
            files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          } catch {}
        }
      }
    };
    visit(this.sessionsRoot);
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24);
  }

  lastEventTimestamp(file) {
    try {
      const start = Math.max(0, file.size - 64 * 1024);
      const handle = fs.openSync(file.path, "r");
      const buffer = Buffer.alloc(file.size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      fs.closeSync(handle);
      const events = parseJsonLines(buffer.toString("utf8"));
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const time = Date.parse(events[index]?.timestamp || "");
        if (Number.isFinite(time)) return time;
      }
    } catch {}
    return file.mtimeMs;
  }

  scanForActiveSession(force) {
    const candidates = this.listRecentSessionFiles();
    if (!candidates.length) {
      this.update({
        connection: "missing",
        mode: "offline",
        phase: "未找到 Codex",
        detail: `未发现 ${this.sessionsRoot}`,
      });
      return;
    }
    this.scanQuotaRecords(candidates);
    const runningTasks = this.scanRunningTasks(candidates);
    const ranked = candidates
      .map((file) => ({ ...file, eventTime: this.lastEventTimestamp(file) }))
      .sort((a, b) => b.eventTime - a.eventTime);
    const newest = runningTasks.length
      ? ranked.find((file) => file.path === runningTasks[0].filePath) || ranked[0]
      : ranked[0];
    if (!force && newest.path === this.activeFile) {
      this.emitState();
      return;
    }
    this.followFile(newest.path, newest.size);
  }

  rememberRateLimits(rateLimits, observedAt) {
    if (!rateLimits || typeof rateLimits !== "object") return;
    const limitId = String(rateLimits.limit_id || "codex");
    const record = { rateLimits, observedAt: Math.max(0, Number(observedAt) || 0) };
    const previous = this.quotaRecords.get(limitId);
    if (!previous || record.observedAt >= previous.observedAt) {
      this.quotaRecords.set(limitId, record);
    }
    this.state.quota = quotaFromRateLimitRecords([...this.quotaRecords.values()]);
  }

  scanQuotaRecords(candidates) {
    const livePaths = new Set(candidates.map((file) => file.path));
    for (const file of candidates) {
      let cached = this.quotaFileCache.get(file.path);
      if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) {
        const start = Math.max(0, file.size - QUOTA_SCAN_BYTES);
        const parsed = readCompleteEvents(file.path, start, file.size);
        cached = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          records: rateLimitRecordsFromEvents(parsed.events),
        };
        this.quotaFileCache.set(file.path, cached);
      }
      cached.records.forEach((record) => this.rememberRateLimits(record.rateLimits, record.observedAt));
    }

    for (const filePath of this.quotaFileCache.keys()) {
      if (!livePaths.has(filePath)) this.quotaFileCache.delete(filePath);
    }
  }

  scanRunningTasks(candidates) {
    const now = Date.now();
    let tasks = [];
    const livePaths = new Set(candidates.map((file) => file.path));

    for (const file of candidates) {
      let cached = this.taskCache.get(file.path);
      if (!cached || file.size < cached.offset) {
        const start = findLastTaskStartOffset(file.path, file.size);
        const parsed = start >= 0
          ? readCompleteEvents(file.path, start, file.size)
          : { events: [], nextOffset: file.size };
        const metadata = this.readSessionMetadata(file.path);
        const summary = taskSummaryFromEvents(parsed.events, {
          threadId: sessionIdFromPath(file.path),
          workspace: metadata.cwd || "",
          mtimeMs: file.mtimeMs,
        });
        cached = { offset: parsed.nextOffset, mtimeMs: file.mtimeMs, summary };
        this.taskCache.set(file.path, cached);
      } else if (file.size > cached.offset || file.mtimeMs !== cached.mtimeMs) {
        const parsed = readCompleteEvents(file.path, cached.offset, file.size);
        const hasNewStart = parsed.events.some((event) => eventType(event) === "task_started");
        const metadata = hasNewStart ? this.readSessionMetadata(file.path) : null;
        const summary = hasNewStart
          ? taskSummaryFromEvents(parsed.events, {
              threadId: sessionIdFromPath(file.path),
              workspace: metadata?.cwd || cached.summary?.workspace || "",
              mtimeMs: file.mtimeMs,
            })
          : cached.summary
            ? advanceTaskSummary({
                ...cached.summary,
                delegations: (cached.summary.delegations || []).map((item) => ({
                  ...item,
                  callIds: [...(item.callIds || [])],
                })),
              }, parsed.events)
            : null;
        cached = { offset: parsed.nextOffset, mtimeMs: file.mtimeMs, summary };
        this.taskCache.set(file.path, cached);
      }

      const startOnly = cached.summary
        && cached.summary.lastEventAt <= cached.summary.startedAt + 1000;
      const staleAfter = startOnly ? START_ONLY_TASK_STALE_MS : RUNNING_TASK_STALE_MS;
      if (cached.summary
        && now - cached.summary.lastEventAt <= staleAfter
        && !this.taskCompletedInLogs(cached.summary)) {
        tasks.push({ ...cached.summary, filePath: file.path });
      }
    }

    for (const filePath of this.taskCache.keys()) {
      if (!livePaths.has(filePath)) this.taskCache.delete(filePath);
    }

    tasks.sort((a, b) => b.lastEventAt - a.lastEventAt);
    tasks = this.openCode.enrichTasks(tasks).map(alignTaskWithDelegations);
    this.runningTasks = tasks;
    this.state.tasks = tasks.map(({ filePath: _filePath, ...task }) => task);
    const focused = tasks.find((task) => task.id === this.state.threadId);
    if (focused && focused.delegations?.some((delegation) => delegation.status === "running")) {
      this.state.mode = focused.mode;
      this.state.phase = focused.phase;
      this.state.detail = focused.detail;
    }
    return tasks;
  }

  taskCompletedInLogs(task) {
    if (!this.db || !task?.id || !task?.startedAt) return false;
    try {
      const rows = this.db.prepare(
        `SELECT feedback_log_body
         FROM logs
         WHERE thread_id = ?
           AND target = 'codex_core::session::turn'
           AND ts >= ?
         ORDER BY id DESC
         LIMIT 16`,
      ).all(task.id, Math.floor(task.startedAt / 1000));
      return rows.some((row) =>
        /model_needs_follow_up=false[\s\S]*needs_follow_up=false/.test(row.feedback_log_body || ""));
    } catch {
      return false;
    }
  }

  followFile(filePath, size) {
    this.activeFile = filePath;
    this.activeOffset = Math.max(0, size - MAX_RECONSTRUCT_BYTES);
    const metadata = this.readSessionMetadata(filePath);
    this.state = {
      ...this.state,
      connection: "connected",
      threadId: sessionIdFromPath(filePath),
      workspace: metadata.cwd || this.state.workspace,
      events: [],
      progress: 0,
      latestReply: "",
      replyAt: 0,
      replyFresh: false,
      delegations: [],
      openCodeHintAt: 0,
      openCodeHintDirectory: "",
    };
    this.readAppended(true);
  }

  readSessionMetadata(filePath) {
    try {
      const handle = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(128 * 1024);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      fs.closeSync(handle);
      const events = parseJsonLines(buffer.subarray(0, bytes).toString("utf8"));
      const metadata = events.find((event) => event?.type === "session_meta");
      return metadata?.payload || {};
    } catch {
      return {};
    }
  }

  poll() {
    if (!this.activeFile) {
      this.scanForActiveSession(true);
      return;
    }
    this.readAppended(false);
    const now = Date.now();
    if (now - this.lastCompletionCheck > 1400) {
      this.lastCompletionCheck = now;
      this.checkCompletionFromLogs();
    }
    if (this.state.mode === "done" && now - this.state.lastEventAt > 30000) {
      this.update({ mode: "resting", phase: "待机中", detail: "Lumo 正在等待下一项任务" });
    }
    this.emitState();
  }

  readAppended(reconstruct) {
    let stat;
    try {
      stat = fs.statSync(this.activeFile);
    } catch {
      this.activeFile = "";
      return;
    }
    if (stat.size < this.activeOffset) this.activeOffset = 0;
    if (stat.size === this.activeOffset) return;
    try {
      const length = stat.size - this.activeOffset;
      const handle = fs.openSync(this.activeFile, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, this.activeOffset);
      fs.closeSync(handle);
      this.activeOffset = stat.size;
      const events = parseJsonLines(buffer.toString("utf8"));
      if (reconstruct) this.reconstruct(events);
      else events.forEach((event) => this.consume(event));
    } catch {
      this.update({ connection: "error", detail: "暂时无法读取 Codex 日志" });
    }
  }

  reconstruct(events) {
    const lastStart = events.map((event) => event?.payload?.type).lastIndexOf("task_started");
    const slice = lastStart >= 0 ? events.slice(lastStart) : events.slice(-120);
    slice.forEach((event) => this.consume(event, true));
    this.emitState(true);
  }

  consume(event, quiet = false) {
    const payload = event?.payload || {};
    const type = payload.type || event?.type;
    const eventTime = Date.parse(event?.timestamp || "") || Date.now();
    const summary = eventSummary(event);
    const patch = { connection: "connected", lastEventAt: eventTime, replyFresh: false };
    const delegationHolder = {
      ...this.state,
      delegations: (this.state.delegations || []).map((item) => ({
        ...item,
        callIds: [...(item.callIds || [])],
      })),
    };
    const delegationUpdate = advanceDelegations(delegationHolder, event);
    const linkedDelegation = delegationHolder.delegations.some((delegation) =>
      (delegation.callIds || []).includes(String(payload.call_id || payload.id || "")),
    );
    patch.delegations = delegationHolder.delegations;
    patch.openCodeHintAt = delegationHolder.openCodeHintAt || 0;
    patch.openCodeHintDirectory = delegationHolder.openCodeHintDirectory || "";

    if (event.type === "session_meta") {
      patch.workspace = payload.cwd || patch.workspace;
    } else if (type === "task_started") {
      patch.mode = "thinking";
      patch.phase = "思考中";
      patch.detail = "正在理解任务";
      patch.progress = 8;
      patch.thinkingStep = 0;
      patch.startedAt = eventTime;
      patch.threadId = this.state.threadId;
      patch.latestReply = "";
      patch.replyAt = 0;
      patch.delegations = [];
      patch.openCodeHintAt = 0;
      patch.openCodeHintDirectory = "";
    } else if (type === "message" && payload.role === "user") {
      patch.task = shortTaskTitle(extractMessageText(payload), this.state.task);
      patch.mode = "thinking";
      patch.phase = "思考中";
      patch.thinkingStep = 1;
      patch.detail = thinkingStage(patch.thinkingStep);
      patch.progress = Math.max(this.state.progress, 12);
    } else if (type === "user_message") {
      patch.task = shortTaskTitle(payload.message, this.state.task);
      patch.mode = "thinking";
      patch.phase = "思考中";
      patch.thinkingStep = 1;
      patch.detail = thinkingStage(patch.thinkingStep);
      patch.progress = Math.max(this.state.progress, 12);
    } else if (type === "agent_reasoning") {
      patch.mode = "thinking";
      patch.phase = "思考中";
      patch.thinkingStep = (this.state.thinkingStep || 0) + 1;
      patch.detail = thinkingStage(patch.thinkingStep);
      patch.progress = Math.min(88, Math.max(this.state.progress + 1, 16));
    } else if (type === "agent_message") {
      const latestReply = shortReply(payload.message);
      patch.mode = "reply";
      patch.phase = "有新回复";
      patch.latestReply = latestReply;
      patch.detail = patch.latestReply;
      patch.replyAt = eventTime;
      patch.replyFresh = !quiet;
      patch.progress = Math.max(this.state.progress, 96);
    } else if (type === "custom_tool_call" || type === "function_call") {
      const waiting = /wait/i.test(payload.name || "");
      patch.mode = waiting ? "waiting" : "working";
      patch.phase = waiting ? "等待中" : "执行中";
      patch.detail = delegationUpdate.created
        ? `已委派 ${delegationUpdate.created} 个 OpenCode 子任务`
        : linkedDelegation
          ? "OpenCode 子任务运行中"
          : labelForTool(payload.name);
      patch.progress = Math.min(92, Math.max(this.state.progress + 3, 24));
    } else if (type === "custom_tool_call_output" || type === "function_call_output") {
      const output = toolOutputText(payload);
      const failed = payload.isError === true
        || /Exit code:\s*[1-9]|Process exited with code\s+[1-9]|"exit_code"\s*:\s*[1-9]/i.test(output);
      patch.mode = failed ? "error" : "working";
      patch.phase = failed ? "调整中" : "执行中";
      patch.detail = linkedDelegation
        ? delegationUpdate.failed
          ? "OpenCode 子任务异常，正在检查结果"
          : delegationUpdate.running
            ? "OpenCode 子任务仍在运行"
            : "OpenCode 子任务已返回结果"
        : failed
          ? "遇到问题，正在尝试其他方法"
          : "正在整理工具结果";
      patch.progress = Math.min(94, Math.max(this.state.progress + 1, 28));
    } else if (type === "token_count") {
      this.rememberRateLimits(payload.rate_limits, eventTime);
      if (this.state.quota) patch.quota = this.state.quota;
    } else if (type === "task_complete" || type === "turn_complete" || type === "turn_completed") {
      patch.mode = "done";
      patch.phase = this.state.latestReply ? "已回复" : "已完成";
      patch.detail = this.state.latestReply || "任务已经完成";
      patch.progress = 100;
      this.state.tasks = (this.state.tasks || []).filter((task) => task.id !== this.state.threadId);
    }

    if (summary && type !== "token_count") this.pushEvent(summary, eventTime);
    this.update(patch, quiet);
  }

  checkCompletionFromLogs() {
    const activeTask = (this.state.tasks || []).some((task) => task.id === this.state.threadId);
    if (!this.db || !this.state.threadId || !this.state.startedAt || this.state.mode === "done" || !activeTask) return;
    try {
      const minTs = Math.floor(this.state.startedAt / 1000);
      const rows = this.db
        .prepare(
          `SELECT ts, feedback_log_body
           FROM logs
           WHERE thread_id = ?
             AND target = 'codex_core::session::turn'
             AND ts >= ?
           ORDER BY id DESC
           LIMIT 16`,
        )
        .all(this.state.threadId, minTs);
      const complete = rows.find((row) =>
        /model_needs_follow_up=false[\s\S]*needs_follow_up=false/.test(row.feedback_log_body || ""),
      );
      if (complete) {
        const completedAt = Number(complete.ts) * 1000;
        this.pushEvent("任务已完成", completedAt);
        this.state.tasks = (this.state.tasks || []).filter((task) => task.id !== this.state.threadId);
        this.update({
          mode: "done",
          phase: "已完成",
          detail: "任务已经完成",
          progress: 100,
          lastEventAt: completedAt,
        });
      }
    } catch {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  pushEvent(label, timestamp) {
    const next = [{ label, timestamp }, ...this.state.events];
    this.state.events = next.slice(0, MAX_EVENT_HISTORY);
  }

  update(patch, quiet = false) {
    this.state = { ...this.state, ...patch };
    if (!quiet) this.emitState();
  }
}

module.exports = {
  advanceDelegations,
  advanceTaskSummary,
  alignTaskWithDelegations,
  CodexMonitor,
  dynamicOpenCodeCommands,
  eventSummary,
  extractOpenCodeInvocations,
  customCommandBodies,
  hasOpenCodeLaunchHint,
  javascriptPromptArrays,
  javascriptPromptVariables,
  extractMessageText,
  labelForTool,
  parseJsonLines,
  quotaFromRateLimits,
  quotaFromRateLimitRecords,
  rateLimitRecordsFromEvents,
  shortTaskTitle,
  stripInjectedContext,
  taskSummaryFromEvents,
  thinkingStage,
  toolOutputText,
};
