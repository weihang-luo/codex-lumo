const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, globalShortcut } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { CodexMonitor } = require("./codex-monitor.cjs");

const COMPACT_SIZE = { width: 420, height: 62 };
const EXPANDED_WIDTH = 520;
const TOP_DOCK_THRESHOLD = 12;
const TOP_PEEK_HEIGHT = 3;
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

let mainWindow = null;
let tray = null;
let monitor = null;
let latestState = null;
let clickThrough = false;
let isQuitting = false;
let settings = { launchAtLogin: false, autoHideTop: true, dockedTop: false, position: null };
let savePositionTimer = null;
let dockEvaluationTimer = null;
let topHideTimer = null;
let cursorPollTimer = null;
let dockedTop = false;
let hiddenAtTop = false;
let windowHovered = false;
let windowExpanded = false;
let internalMove = false;
let revealUntil = 0;
let lastStateSignal = "";

const traySvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="16" fill="#050506"/>
  <path d="M9 12l3-5 4 4 4-4 3 5v10c0 3-3 5-7 5s-7-2-7-5V12z" fill="#f7f7f9"/>
  <rect x="11" y="13" width="10" height="7" rx="3.5" fill="#111113"/>
  <circle cx="14" cy="16.5" r="1" fill="#2997ff"/>
  <circle cx="18" cy="16.5" r="1" fill="#2997ff"/>
</svg>`;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {}
  dockedTop = Boolean(settings.dockedTop && settings.autoHideTop);
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {}
}

function defaultBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(workArea.x + (workArea.width - COMPACT_SIZE.width) / 2),
    y: workArea.y + 20,
    ...COMPACT_SIZE,
  };
}

function visiblePosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const displays = screen.getAllDisplays();
  const visible = displays.some(({ workArea }) =>
    position.x >= workArea.x - COMPACT_SIZE.width / 2 &&
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
    if (internalMove) return;
    clearTimeout(savePositionTimer);
    clearTimeout(dockEvaluationTimer);
    savePositionTimer = setTimeout(() => {
      if (!mainWindow) return;
      const { x, y } = mainWindow.getBounds();
      const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
      settings.position = { x, y: dockedTop ? workArea.y : y };
      settings.dockedTop = dockedTop;
      saveSettings();
    }, 350);
    dockEvaluationTimer = setTimeout(evaluateTopDock, 520);
  });
}

function setBoundsInternally(bounds, animate = false) {
  if (!mainWindow) return;
  internalMove = true;
  mainWindow.setBounds(bounds, animate);
  setTimeout(() => {
    internalMove = false;
  }, animate ? 260 : 60);
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

function hideAtTop() {
  if (!mainWindow || !dockedTop || !settings.autoHideTop || windowHovered || windowExpanded) return;
  if (Date.now() < revealUntil) {
    scheduleTopHide(Math.max(250, revealUntil - Date.now()));
    return;
  }
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  hiddenAtTop = true;
  setBoundsInternally({ ...bounds, y: workArea.y - bounds.height + TOP_PEEK_HEIGHT }, true);
}

function revealTop(duration = 0) {
  if (!mainWindow || !dockedTop) return;
  const bounds = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  hiddenAtTop = false;
  if (duration > 0) revealUntil = Math.max(revealUntil, Date.now() + duration);
  setBoundsInternally({ ...bounds, y: workArea.y }, true);
  if (duration > 0) scheduleTopHide(duration + 160);
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
    revealTop(1800);
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
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(traySvg).toString("base64")}`,
  );
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
  return settings.launchAtLogin;
}

function expandedSize(taskCount = 1) {
  const visibleRows = Math.max(1, Math.min(5, Number(taskCount) || 1));
  return { width: EXPANDED_WIDTH, height: 210 + visibleRows * 44 };
}

function resizeWindow(expanded, taskCount = 1) {
  if (!mainWindow) return false;
  const next = expanded ? expandedSize(taskCount) : COMPACT_SIZE;
  windowExpanded = Boolean(expanded);
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current).workArea;
  next.height = Math.min(next.height, display.height - 20);
  const centerX = current.x + current.width / 2;
  const x = Math.max(display.x, Math.min(display.x + display.width - next.width, Math.round(centerX - next.width / 2)));
  const y = dockedTop
    ? display.y
    : Math.max(display.y, Math.min(display.y + display.height - next.height, current.y));
  hiddenAtTop = false;
  setBoundsInternally({ x, y, ...next }, true);
  if (dockedTop && !windowExpanded) scheduleTopHide(900);
  return true;
}

function registerIpc() {
  ipcMain.handle("lumo:get-state", () => latestState);
  ipcMain.handle("lumo:resize", (_event, expanded, taskCount) => resizeWindow(expanded, taskCount));
  ipcMain.handle("lumo:hide", () => mainWindow?.hide());
  ipcMain.handle("lumo:quit", () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle("lumo:open-logs", () => shell.openPath(path.join(codexRoot, "sessions")));
  ipcMain.handle("lumo:toggle-click-through", () => setClickThrough(!clickThrough));
  ipcMain.handle("lumo:get-settings", () => ({ ...settings, clickThrough }));
  ipcMain.handle("lumo:set-launch-at-login", (_event, enabled) => setLaunchAtLogin(enabled));
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
      mainWindow.show();
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
        if (hiddenAtTop) revealTop(1800);
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
      const tasksSignal = (state.tasks || [])
        .map((task) => [task.id, task.mode, task.phase, task.progress, task.task].join("~"))
        .join(";");
      const stateSignal = [state.mode, state.phase, state.detail, state.progress, state.task, tasksSignal].join("|");
      if (lastStateSignal && stateSignal !== lastStateSignal && dockedTop) {
        revealTop(4200);
      }
      lastStateSignal = stateSignal;
      rebuildTrayMenu();
    });
    monitor.start();
  });
}

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  isQuitting = true;
  monitor?.stop();
  clearInterval(cursorPollTimer);
  globalShortcut.unregisterAll();
});
