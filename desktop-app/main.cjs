const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, globalShortcut } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { CodexMonitor } = require("./codex-monitor.cjs");

const COMPACT_SIZE = { width: 430, height: 96 };
const EXPANDED_SIZE = { width: 560, height: 356 };
const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

let mainWindow = null;
let tray = null;
let monitor = null;
let latestState = null;
let clickThrough = false;
let isQuitting = false;
let settings = { launchAtLogin: false, position: null };
let savePositionTimer = null;

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
  mainWindow.once("ready-to-show", () => mainWindow?.showInactive());
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("move", () => {
    clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => {
      if (!mainWindow) return;
      const { x, y } = mainWindow.getBounds();
      settings.position = { x, y };
      saveSettings();
    }, 350);
  });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (clickThrough) {
    setClickThrough(false);
    mainWindow.showInactive();
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

function resizeWindow(expanded) {
  if (!mainWindow) return false;
  const next = expanded ? EXPANDED_SIZE : COMPACT_SIZE;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current).workArea;
  const centerX = current.x + current.width / 2;
  const x = Math.max(display.x, Math.min(display.x + display.width - next.width, Math.round(centerX - next.width / 2)));
  const y = Math.max(display.y, Math.min(display.y + display.height - next.height, current.y));
  mainWindow.setBounds({ x, y, ...next }, true);
  return true;
}

function registerIpc() {
  ipcMain.handle("lumo:get-state", () => latestState);
  ipcMain.handle("lumo:resize", (_event, expanded) => resizeWindow(expanded));
  ipcMain.handle("lumo:hide", () => mainWindow?.hide());
  ipcMain.handle("lumo:quit", () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle("lumo:open-logs", () => shell.openPath(path.join(codexRoot, "sessions")));
  ipcMain.handle("lumo:toggle-click-through", () => setClickThrough(!clickThrough));
  ipcMain.handle("lumo:get-settings", () => ({ ...settings, clickThrough }));
  ipcMain.handle("lumo:set-launch-at-login", (_event, enabled) => setLaunchAtLogin(enabled));
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
        toggleWindow();
      }
    });

    monitor = new CodexMonitor();
    monitor.on("state", (state) => {
      latestState = state;
      mainWindow?.webContents.send("lumo:state", state);
      rebuildTrayMenu();
    });
    monitor.start();
  });
}

app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  isQuitting = true;
  monitor?.stop();
  globalShortcut.unregisterAll();
});
