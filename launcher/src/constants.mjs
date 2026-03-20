import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(here, "..", "..");
export const launcherRoot = resolve(here, "..");
export const launcherRuntimeDir = join(repoRoot, ".rbxmcp", "launcher");
export const launcherLogsDir = join(launcherRuntimeDir, "logs");
export const launcherProfilesPath = join(launcherRuntimeDir, "profiles.json");
export const launcherRuntimePath = join(launcherRuntimeDir, "runtime.json");
export const launcherControlPort = 5124;
export const launcherControlHost = "127.0.0.1";
export const launcherControlBaseUrl = `http://${launcherControlHost}:${launcherControlPort}/launcher`;
export const defaultWorkspacePath = repoRoot;
export const healthTimeoutMs = 1500;
export const startupTimeoutMs = 30000;
export const refreshIntervalMs = 3000;
export const maxLogTailLines = 240;
