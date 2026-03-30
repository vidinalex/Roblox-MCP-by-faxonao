import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(here, "..", "..");
export const automationRoot = resolve(here, "..");
export const runtimeRoot = join(repoRoot, ".rbxmcp", "automation");
export const runtimeLogsDir = join(runtimeRoot, "logs");
export const runtimeArtifactsDir = join(runtimeRoot, "artifacts");
export const runtimeTempDir = join(runtimeRoot, "tmp");
export const runtimeConfigPath = join(runtimeRoot, "config.local.json");
export const runtimeDbPath = join(runtimeRoot, "db.sqlite");
export const launcherProfilesPath = join(repoRoot, ".rbxmcp", "launcher", "profiles.json");
