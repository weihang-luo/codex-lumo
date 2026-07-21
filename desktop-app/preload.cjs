const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumo", {
  getState: () => ipcRenderer.invoke("lumo:get-state"),
  resize: (expanded, taskCount = 1) => ipcRenderer.invoke("lumo:resize", Boolean(expanded), Number(taskCount) || 1),
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
});
