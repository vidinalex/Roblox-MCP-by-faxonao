const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rbxmcpLauncher", {
  getState: () => ipcRenderer.invoke("launcher:getState"),
  createProfile: (payload) => ipcRenderer.invoke("launcher:createProfile", payload),
  updateProfile: (id, patch) => ipcRenderer.invoke("launcher:updateProfile", id, patch),
  deleteProfile: (id) => ipcRenderer.invoke("launcher:deleteProfile", id),
  duplicateProfile: (id) => ipcRenderer.invoke("launcher:duplicateProfile", id),
  startProfile: (id) => ipcRenderer.invoke("launcher:startProfile", id),
  stopProfile: (id) => ipcRenderer.invoke("launcher:stopProfile", id),
  restartProfile: (id) => ipcRenderer.invoke("launcher:restartProfile", id),
  getLogs: (id) => ipcRenderer.invoke("launcher:getLogs", id),
  getAllLogs: () => ipcRenderer.invoke("launcher:getAllLogs"),
  copyMcpUrl: (port) => ipcRenderer.invoke("launcher:copyMcpUrl", port),
  copyAiPrompt: (id) => ipcRenderer.invoke("launcher:copyAiPrompt", id),
  copyDiagnostics: (id) => ipcRenderer.invoke("launcher:copyDiagnostics", id),
  openLogFile: (id) => ipcRenderer.invoke("launcher:openLogFile", id)
});
