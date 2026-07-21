const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumo", {
  getState: () => ipcRenderer.invoke("lumo:get-state"),
  resize: (expanded, taskCount = 1, view = "tasks") =>
    ipcRenderer.invoke("lumo:resize", Boolean(expanded), Number(taskCount) || 1, view),
  hide: () => ipcRenderer.invoke("lumo:hide"),
  quit: () => ipcRenderer.invoke("lumo:quit"),
  openLogs: () => ipcRenderer.invoke("lumo:open-logs"),
  toggleClickThrough: () => ipcRenderer.invoke("lumo:toggle-click-through"),
  getSettings: () => ipcRenderer.invoke("lumo:get-settings"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("lumo:set-launch-at-login", Boolean(enabled)),
  setHovered: (hovered) => ipcRenderer.send("lumo:set-hovered", Boolean(hovered)),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("lumo:state", handler);
    return () => ipcRenderer.removeListener("lumo:state", handler);
  },
  onClickThrough: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on("lumo:click-through", handler);
    return () => ipcRenderer.removeListener("lumo:click-through", handler);
  },
  onSettings: (callback) => {
    const handler = (_event, settings) => callback(settings);
    ipcRenderer.on("lumo:settings", handler);
    return () => ipcRenderer.removeListener("lumo:settings", handler);
  },
  onDockMotion: (callback) => {
    const handler = (_event, phase) => callback(phase);
    ipcRenderer.on("lumo:dock-motion", handler);
    return () => ipcRenderer.removeListener("lumo:dock-motion", handler);
  },
});
