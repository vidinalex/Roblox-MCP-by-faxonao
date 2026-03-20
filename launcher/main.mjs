import { BrowserWindow, app, clipboard, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LauncherService } from "./src/service.mjs";
import { startLauncherControlApi } from "./src/controlApi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let launcherService;
let controlApi;
let mainWindow;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#10141f",
    title: "RBXMCP Launcher",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await mainWindow.loadFile(join(here, "index.html"));
}

function bindIpc() {
  ipcMain.handle("launcher:getState", async () => await launcherService.getState());
  ipcMain.handle("launcher:createProfile", async (_event, payload) => await launcherService.createProfile(payload));
  ipcMain.handle("launcher:updateProfile", async (_event, id, patch) => await launcherService.updateProfile(id, patch));
  ipcMain.handle("launcher:deleteProfile", async (_event, id) => await launcherService.deleteProfile(id));
  ipcMain.handle("launcher:duplicateProfile", async (_event, id) => await launcherService.duplicateProfile(id));
  ipcMain.handle("launcher:startProfile", async (_event, id) => await launcherService.startProfile(id));
  ipcMain.handle("launcher:stopProfile", async (_event, id) => await launcherService.stopProfile(id));
  ipcMain.handle("launcher:restartProfile", async (_event, id) => await launcherService.restartProfile(id));
  ipcMain.handle("launcher:getLogs", async (_event, id) => await launcherService.tailProfileLogs(id));
  ipcMain.handle("launcher:getAllLogs", async () => await launcherService.tailAllLogs());
  ipcMain.handle("launcher:copyMcpUrl", async (_event, port) => {
    const url = `http://127.0.0.1:${port}`;
    clipboard.writeText(url);
    return { ok: true, url };
  });
  ipcMain.handle("launcher:copyAiPrompt", async (_event, id) => {
    const prompt = await launcherService.buildAiPrompt(id);
    clipboard.writeText(prompt);
    return { ok: true };
  });
  ipcMain.handle("launcher:copyDiagnostics", async (_event, id) => {
    const diagnostics = await launcherService.copyDiagnostics(id);
    clipboard.writeText(diagnostics);
    return { ok: true };
  });
  ipcMain.handle("launcher:openLogFile", async (_event, id) => {
    const logs = await launcherService.tailProfileLogs(id);
    return await shell.openPath(logs.logPath);
  });
}

app.on("window-all-closed", async () => {
  await launcherService?.dispose();
  controlApi?.server?.close?.();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.whenReady().then(async () => {
  launcherService = new LauncherService();
  await launcherService.bootstrap();
  controlApi = await startLauncherControlApi(launcherService);
  bindIpc();
  await createWindow();
});
