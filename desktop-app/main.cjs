const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, globalShortcut } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { CodexMonitor } = require("./codex-monitor.cjs");
const { SystemMonitor } = require("./system-monitor.cjs");
const { ProgressRevealPolicy } = require("./reveal-policy.cjs");
const {
  DEFAULT_REVEAL_MS,
  DEFAULT_WINDOW_SIZE,
  TOP_DOCK_GAP,
  expandedSize,
  normalizeRevealMs,
  normalizeWindowSize,
  profileFor,
} = require("./window-config.cjs");

const TOP_DOCK_THRESHOLD = 12;
const TOP_PEEK_HEIGHT = 3;
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const appIconPath = path.join(__dirname, "assets", "lumo.ico");

let mainWindow = null;
let tray = null;
let monitor = null;
let systemMonitor = null;
let latestState = null;
let latestSystem = null;
let clickThrough = false;
let isQuitting = false;
let settings = {
  launchAtLogin: false,
  autoHideTop: true,
  dockedTop: false,
  position: null,
  windowSize: DEFAULT_WINDOW_SIZE,
  updateRevealMs: DEFAULT_REVEAL_MS,
};
let savePositionTimer = null;
let topHideTimer = null;
let topAnimationTimer = null;
let cursorPollTimer = null;
let dockedTop = false;
let hiddenAtTop = false;
let windowHovered = false;
let windowExpanded = false;
let windowView = "tasks";
let internalMove = false;
let revealUntil = 0;
const progressRevealPolicy = new ProgressRevealPolicy();
let dragSession = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {}
  settings.windowSize = normalizeWindowSize(settings.windowSize);
  settings.updateRevealMs = normalizeRevealMs(settings.updateRevealMs);
  dockedTop = Boolean(settings.dockedTop && settings.autoHideTop);
}

function publicSettings() {
  return { ...settings, clickThrough };
}

function broadcastSettings() {
  mainWindow?.webContents.send("lumo:settings", publicSettings());
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {}
}

function defaultBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const compact = profileFor(settings.windowSize).compact;
  return {
    x: Math.round(workArea.x + (workArea.width - compact.width) / 2),
    y: workArea.y + 20,
    ...compact,
  };
}

function visiblePosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const compact = profileFor(settings.windowSize).compact;
  const displays = screen.getAllDisplays();
  const visible = displays.some(({ workArea }) =>
    position.x >= workArea.x - compact.width / 2 &&
    position.x <= workArea.x + workArea.width - 40 &&
    position.y >= workArea.y - 20 &&
    position.y <= workArea.y + workArea.height - 40,
  );
  return visible ? position : null;
}

function createWindow() {
  const base = defaultBounds();
  const saved = visiblePosition(settings.position);
  mainWindow = new BrowserWindow({
    ...base,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating", 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    broadcastSettings();
    mainWindow?.showInactive();
    if (dockedTop) {
      revealTop(1800);
      scheduleTopHide(2000);
    }
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("move", () => {
    if (internalMove || dragSession) return;
    clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => {
      if (!mainWindow) return;
      const { x, y } = mainWindow.getBounds();
      settings.position = { x, y };
      settings.dockedTop = dockedTop;
      saveSettings();
    }, 350);
  });
}

function setBoundsInternally(bounds, animate = false) {
  if (!mainWindow) return;
  clearInterval(topAnimationTimer);
  topAnimationTimer = null;
  internalMove = true;
  mainWindow.setBounds(bounds, animate);
  setTimeout(() => {
    internalMove = false;
  }, animate ? 260 : 60);
}

function sendDockMotion(phase) {
  mainWindow?.webContents.send("lumo:dock-motion", phase);
}

function animateWindowY(targetY, duration, motion) {
  if (!mainWindow) return;
  clearInterval(topAnimationTimer);
  const startBounds = mainWindow.getBounds();
  const startX = Math.round(Number(startBounds.x));
  const startY = Math.round(Number(startBounds.y));
  const destinationY = Math.round(Number(targetY));
  const animationDuration = Math.max(1, Number(duration) || 1);
  if (![startX, startY, destinationY, startBounds.width, startBounds.height].every(Number.isFinite)) {
    internalMove = false;
    return;
  }
  if (startY === destinationY) {
    sendDockMotion(motion === "showing" ? "visible" : "hidden");
    return;
  }

  const startedAt = Date.now();
  internalMove = true;
  sendDockMotion(motion);
  topAnimationTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(topAnimationTimer);
      topAnimationTimer = null;
      internalMove = false;
      return;
    }
    const raw = Math.min(1, (Date.now() - startedAt) / animationDuration);
    const eased = motion === "showing"
      ? 1 - Math.pow(1 - raw, 4)
      : raw * raw * (3 - 2 * raw);
    const y = Math.round(startY + (destinationY - startY) * eased);
    try {
      mainWindow.setBounds({ ...startBounds, x: startX, y }, false);
    } catch {
      clearInterval(topAnimationTimer);
      topAnimationTimer = null;
      internalMove = false;
      return;
    }
    if (raw >= 1) {
      clearInterval(topAnimationTimer);
      topAnimationTimer = null;
      mainWindow.setBounds({ ...startBounds, x: startX, y: destinationY }, false);
      setTimeout(() => {
        internalMove = false;
      }, 40);
      sendDockMotion(motion === "showing" ? "visible" : "hidden");
    }
  }, 16);
}

function evaluateTopDock() {
  if (!mainWindow || !settings.autoHideTop || internalMove) return;
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  if (bounds.y <= workArea.y + TOP_DOCK_THRESHOLD) {
    dockedTop = true;
    settings.dockedTop = true;
    revealTop(900);
    scheduleTopHide(1000);
  } else if (!hiddenAtTop) {
    dockedTop = false;
    settings.dockedTop = false;
  }
  saveSettings();
  rebuildTrayMenu();
}

function startWindowDrag(screenX, screenY) {
  if (!mainWindow || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return false;
  dragSession = {
    startX: screenX,
    startY: screenY,
    startBounds: mainWindow.getBounds(),
    moved: false,
    wasDocked: dockedTop,
  };
  return true;
}

function moveWindowDrag(screenX, screenY) {
  if (!mainWindow || !dragSession || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  const deltaX = Math.round(screenX - dragSession.startX);
  const deltaY = Math.round(screenY - dragSession.startY);
  if (!dragSession.moved && Math.hypot(deltaX, deltaY) < 3) return;

  if (!dragSession.moved) {
    clearTimeout(topHideTimer);
    clearInterval(topAnimationTimer);
    topAnimationTimer = null;
    dragSession.moved = true;
    dockedTop = false;
    hiddenAtTop = false;
    settings.dockedTop = false;
    revealUntil = 0;
    sendDockMotion("visible");
  }

  internalMove = true;
  try {
    mainWindow.setPosition(
      dragSession.startBounds.x + deltaX,
      dragSession.startBounds.y + deltaY,
      false,
    );
  } catch {}
}

function endWindowDrag(rendererMoved) {
  if (!mainWindow || !dragSession) return false;
  const completed = dragSession;
  dragSession = null;
  internalMove = false;
  if (!completed.moved || !rendererMoved) {
    if (completed.wasDocked) scheduleTopHide(850);
    return false;
  }

  const { x, y } = mainWindow.getBounds();
  settings.position = { x, y };
  settings.dockedTop = false;
  saveSettings();
  evaluateTopDock();
  return true;
}

function hideAtTop() {
  if (!mainWindow || !dockedTop || !settings.autoHideTop || windowHovered || windowExpanded) return;
  if (Date.now() < revealUntil) {
    scheduleTopHide(Math.max(250, revealUntil - Date.now()));
    return;
  }
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  hiddenAtTop = true;
  animateWindowY(workArea.y - bounds.height + TOP_PEEK_HEIGHT, 360, "hiding");
}

function revealTop(duration = 0) {
  if (!mainWindow || !dockedTop) return;
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  hiddenAtTop = false;
  if (duration > 0) revealUntil = Math.max(revealUntil, Date.now() + duration);
  animateWindowY(workArea.y + TOP_DOCK_GAP, 300, "showing");
  if (duration > 0) scheduleTopHide(duration + 220);
}

function scheduleTopHide(delay = 700) {
  clearTimeout(topHideTimer);
  if (!dockedTop || !settings.autoHideTop) return;
  topHideTimer = setTimeout(hideAtTop, delay);
}

function setAutoHideTop(enabled) {
  settings.autoHideTop = Boolean(enabled);
  if (!settings.autoHideTop) {
    revealTop();
    dockedTop = false;
    hiddenAtTop = false;
    settings.dockedTop = false;
  } else {
    evaluateTopDock();
  }
  saveSettings();
  rebuildTrayMenu();
  broadcastSettings();
  return settings.autoHideTop;
}

function toggleWindow() {
  if (!mainWindow) return;
  if (clickThrough) {
    setClickThrough(false);
    mainWindow.showInactive();
    return;
  }
  if (hiddenAtTop) {
    revealTop(settings.updateRevealMs);
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else {
    if (clickThrough) setClickThrough(false);
    mainWindow.showInactive();
  }
}

function setClickThrough(enabled) {
  clickThrough = Boolean(enabled);
  if (mainWindow) mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  mainWindow?.webContents.send("lumo:click-through", clickThrough);
  rebuildTrayMenu();
  return clickThrough;
}

function updateSettings(patch = {}) {
  const previousSize = settings.windowSize;
  if (Object.hasOwn(patch, "windowSize")) {
    settings.windowSize = normalizeWindowSize(patch.windowSize);
  }
  if (Object.hasOwn(patch, "updateRevealMs")) {
    settings.updateRevealMs = normalizeRevealMs(patch.updateRevealMs);
  }
  if (Object.hasOwn(patch, "autoHideTop") && Boolean(patch.autoHideTop) !== settings.autoHideTop) {
    settings.autoHideTop = Boolean(patch.autoHideTop);
    if (!settings.autoHideTop) {
      revealTop();
      dockedTop = false;
      hiddenAtTop = false;
      settings.dockedTop = false;
    } else {
      evaluateTopDock();
    }
  }

  saveSettings();
  if (settings.windowSize !== previousSize && mainWindow) {
    const taskCount = Math.max(1, latestState?.tasks?.length || 1);
    resizeWindow(windowExpanded, taskCount, windowView);
  }
  broadcastSettings();
  rebuildTrayMenu();
  return publicSettings();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const status = latestState ? `${latestState.phase} · ${latestState.progress}%` : "正在连接 Codex";
  tray.setToolTip(`Codex Lumo — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: "separator" },
      { label: mainWindow?.isVisible() ? "隐藏 Lumo" : "显示 Lumo", click: toggleWindow },
      {
        label: "鼠标穿透",
        type: "checkbox",
        checked: clickThrough,
        click: (item) => setClickThrough(item.checked),
      },
      {
        label: "贴顶自动隐藏",
        type: "checkbox",
        checked: settings.autoHideTop,
        click: (item) => setAutoHideTop(item.checked),
      },
      {
        label: "悬浮窗尺寸",
        submenu: [
          { label: "小 · 394 × 58", type: "radio", checked: settings.windowSize === "small", click: () => updateSettings({ windowSize: "small" }) },
          { label: "标准 · 450 × 66", type: "radio", checked: settings.windowSize === "medium", click: () => updateSettings({ windowSize: "medium" }) },
          { label: "大 · 522 × 77", type: "radio", checked: settings.windowSize === "large", click: () => updateSettings({ windowSize: "large" }) },
        ],
      },
      {
        label: "更新弹出时长",
        submenu: [
          { label: "不自动弹出", type: "radio", checked: settings.updateRevealMs === 0, click: () => updateSettings({ updateRevealMs: 0 }) },
          { label: "3 秒", type: "radio", checked: settings.updateRevealMs === 3000, click: () => updateSettings({ updateRevealMs: 3000 }) },
          { label: "5 秒", type: "radio", checked: settings.updateRevealMs === 5000, click: () => updateSettings({ updateRevealMs: 5000 }) },
          { label: "8 秒", type: "radio", checked: settings.updateRevealMs === 8000, click: () => updateSettings({ updateRevealMs: 8000 }) },
        ],
      },
      {
        label: "开机启动",
        type: "checkbox",
        checked: settings.launchAtLogin,
        click: (item) => setLaunchAtLogin(item.checked),
      },
      { label: "打开 Codex 日志目录", click: () => shell.openPath(path.join(codexRoot, "sessions")) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(appIconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on("click", toggleWindow);
  rebuildTrayMenu();
}

function setLaunchAtLogin(enabled) {
  settings.launchAtLogin = Boolean(enabled);
  if (app.isPackaged) {
    const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: executablePath });
  }
  saveSettings();
  rebuildTrayMenu();
  broadcastSettings();
  return settings.launchAtLogin;
}

function resizeWindow(expanded, taskCount = 1, view = "tasks") {
  if (!mainWindow) return false;
  const next = expanded
    ? expandedSize(settings.windowSize, taskCount, view)
    : { ...profileFor(settings.windowSize).compact };
  windowExpanded = Boolean(expanded);
  windowView = view === "settings" ? "settings" : "tasks";
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current).workArea;
  next.height = Math.min(next.height, display.height - 20);
  const centerX = current.x + current.width / 2;
  const x = Math.max(display.x, Math.min(display.x + display.width - next.width, Math.round(centerX - next.width / 2)));
  const y = dockedTop
    ? display.y + TOP_DOCK_GAP
    : Math.max(display.y, Math.min(display.y + display.height - next.height, current.y));
  hiddenAtTop = false;
  setBoundsInternally({ x, y, ...next }, true);
  if (dockedTop && !windowExpanded) scheduleTopHide(900);
  return true;
}

async function openCodex() {
  try {
    await shell.openExternal("codex://");
    return true;
  } catch {
    if (process.platform !== "win32") return false;
    try {
      await shell.openExternal("shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App");
      return true;
    } catch {
      return false;
    }
  }
}

function registerIpc() {
  ipcMain.handle("lumo:get-state", () => latestState);
  ipcMain.handle("lumo:get-system", () => latestSystem);
  ipcMain.handle("lumo:resize", (_event, expanded, taskCount, view) => resizeWindow(expanded, taskCount, view));
  ipcMain.handle("lumo:hide", () => mainWindow?.hide());
  ipcMain.handle("lumo:open-codex", openCodex);
  ipcMain.handle("lumo:quit", () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle("lumo:open-logs", () => shell.openPath(path.join(codexRoot, "sessions")));
  ipcMain.handle("lumo:toggle-click-through", () => setClickThrough(!clickThrough));
  ipcMain.handle("lumo:get-settings", () => publicSettings());
  ipcMain.handle("lumo:update-settings", (_event, patch) => updateSettings(patch));
  ipcMain.handle("lumo:set-launch-at-login", (_event, enabled) => setLaunchAtLogin(enabled));
  ipcMain.handle("lumo:drag-start", (_event, screenX, screenY) => startWindowDrag(screenX, screenY));
  ipcMain.on("lumo:drag-move", (_event, screenX, screenY) => moveWindowDrag(screenX, screenY));
  ipcMain.handle("lumo:drag-end", (_event, moved) => endWindowDrag(moved));
  ipcMain.on("lumo:set-hovered", (_event, hovered) => {
    windowHovered = Boolean(hovered);
    if (windowHovered && hiddenAtTop) revealTop();
    if (!windowHovered) scheduleTopHide(680);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      setClickThrough(false);
      mainWindow.showInactive();
      if (hiddenAtTop) revealTop(settings.updateRevealMs);
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    registerIpc();
    createWindow();
    createTray();
    globalShortcut.register("CommandOrControl+Alt+L", () => {
      if (clickThrough) {
        setClickThrough(false);
        mainWindow?.showInactive();
      } else {
        if (hiddenAtTop) revealTop(settings.updateRevealMs);
        else toggleWindow();
      }
    });

    cursorPollTimer = setInterval(() => {
      if (!mainWindow || !hiddenAtTop) return;
      const point = screen.getCursorScreenPoint();
      const bounds = mainWindow.getBounds();
      const workArea = screen.getDisplayMatching(bounds).workArea;
      const overPeek =
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= workArea.y &&
        point.y <= workArea.y + TOP_PEEK_HEIGHT + 6;
      if (overPeek) {
        windowHovered = true;
        revealTop();
      }
    }, 120);

    monitor = new CodexMonitor();
    monitor.on("state", (state) => {
      latestState = state;
      mainWindow?.webContents.send("lumo:state", state);
      if (progressRevealPolicy.shouldReveal(state) && dockedTop && settings.updateRevealMs > 0) {
        revealTop(settings.updateRevealMs);
      }
      rebuildTrayMenu();
    });
    monitor.start();

    systemMonitor = new SystemMonitor();
    systemMonitor.on("state", (state) => {
      latestSystem = state;
      mainWindow?.webContents.send("lumo:system", state);
    });
    systemMonitor.start();
  });
}

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  isQuitting = true;
  monitor?.stop();
  systemMonitor?.stop();
  clearInterval(cursorPollTimer);
  clearInterval(topAnimationTimer);
  globalShortcut.unregisterAll();
});
