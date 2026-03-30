import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { launcherProfilesPath, runtimeArtifactsDir, runtimeConfigPath, runtimeLogsDir, runtimeRoot, runtimeTempDir } from "./paths.mjs";

const defaultTaskHubPort = 5130;

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readLauncherProfiles() {
  try {
    const raw = await readFile(launcherProfilesPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function buildDefaultConfig(profiles) {
  return {
    version: 1,
    taskHub: {
      host: "127.0.0.1",
      port: defaultTaskHubPort
    },
    telegram: {
      enabled: false,
      botToken: "",
      pollIntervalMs: 2000,
      longPollTimeoutSec: 20,
      allowedChatIds: []
    },
    linear: {
      enabled: false,
      apiKey: "",
      pollIntervalMs: 90000,
      teamIds: [],
      projectIds: [],
      labelNames: [],
      stateNames: [],
      syncComments: true,
      syncStateTransitions: true
    },
    codex: {
      runtime: "wsl",
      timeoutMs: 900000,
      wslDistro: "",
      wslCommand: "",
      linuxWorkspaceRoot: "",
      windowsCommand: "",
      mockMode: {
        triageDelayMs: 50,
        executeDelayMs: 50
      }
    },
    launcher: {
      controlBaseUrl: "http://127.0.0.1:5124/launcher"
    },
    projectMappings: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      launcherProfileId: profile.id,
      port: normalizeText(profile.port),
      expectedPlaceId: normalizeText(profile.expectedPlaceId),
      telegramChatId: "",
      linearTeamId: "",
      linearProjectId: "",
      linearLabel: "",
      linearIssuePrefix: "",
      workspacePath: normalizeText(profile.workspacePath)
    }))
  };
}

function normalizeProjectMapping(mapping) {
  return {
    id: normalizeText(mapping.id),
    name: normalizeText(mapping.name, normalizeText(mapping.id, "Project")),
    launcherProfileId: normalizeText(mapping.launcherProfileId),
    port: normalizeText(mapping.port),
    expectedPlaceId: normalizeText(mapping.expectedPlaceId),
    telegramChatId: normalizeText(mapping.telegramChatId),
    linearTeamId: normalizeText(mapping.linearTeamId),
    linearProjectId: normalizeText(mapping.linearProjectId),
    linearLabel: normalizeText(mapping.linearLabel),
    linearIssuePrefix: normalizeText(mapping.linearIssuePrefix),
    workspacePath: normalizeText(mapping.workspacePath)
  };
}

function normalizeConfig(config, fallbackProfiles) {
  const defaults = buildDefaultConfig(fallbackProfiles);
  return {
    version: 1,
    taskHub: {
      host: normalizeText(config.taskHub?.host, defaults.taskHub.host),
      port: normalizeInteger(config.taskHub?.port, defaults.taskHub.port)
    },
    telegram: {
      enabled: config.telegram?.enabled === true,
      botToken: normalizeText(config.telegram?.botToken),
      pollIntervalMs: normalizeInteger(config.telegram?.pollIntervalMs, defaults.telegram.pollIntervalMs),
      longPollTimeoutSec: normalizeInteger(config.telegram?.longPollTimeoutSec, defaults.telegram.longPollTimeoutSec),
      allowedChatIds: Array.isArray(config.telegram?.allowedChatIds)
        ? config.telegram.allowedChatIds.map((entry) => normalizeText(entry)).filter(Boolean)
        : []
    },
    linear: {
      enabled: config.linear?.enabled === true,
      apiKey: normalizeText(config.linear?.apiKey),
      pollIntervalMs: normalizeInteger(config.linear?.pollIntervalMs, defaults.linear.pollIntervalMs),
      teamIds: Array.isArray(config.linear?.teamIds) ? config.linear.teamIds.map((entry) => normalizeText(entry)).filter(Boolean) : [],
      projectIds: Array.isArray(config.linear?.projectIds) ? config.linear.projectIds.map((entry) => normalizeText(entry)).filter(Boolean) : [],
      labelNames: Array.isArray(config.linear?.labelNames) ? config.linear.labelNames.map((entry) => normalizeText(entry)).filter(Boolean) : [],
      stateNames: Array.isArray(config.linear?.stateNames) ? config.linear.stateNames.map((entry) => normalizeText(entry)).filter(Boolean) : [],
      syncComments: config.linear?.syncComments !== false,
      syncStateTransitions: config.linear?.syncStateTransitions !== false
    },
    codex: {
      runtime: ["wsl", "windows", "mock"].includes(config.codex?.runtime) ? config.codex.runtime : defaults.codex.runtime,
      timeoutMs: normalizeInteger(config.codex?.timeoutMs, defaults.codex.timeoutMs),
      model: normalizeText(config.codex?.model),
      reasoningEffort: normalizeText(config.codex?.reasoningEffort),
      wslDistro: normalizeText(config.codex?.wslDistro),
      wslCommand: normalizeText(config.codex?.wslCommand),
      linuxWorkspaceRoot: normalizeText(config.codex?.linuxWorkspaceRoot),
      windowsCommand: normalizeText(config.codex?.windowsCommand),
      mockMode: {
        triageDelayMs: normalizeInteger(config.codex?.mockMode?.triageDelayMs, defaults.codex.mockMode.triageDelayMs),
        executeDelayMs: normalizeInteger(config.codex?.mockMode?.executeDelayMs, defaults.codex.mockMode.executeDelayMs)
      }
    },
    launcher: {
      controlBaseUrl: normalizeText(config.launcher?.controlBaseUrl, defaults.launcher.controlBaseUrl)
    },
    projectMappings: Array.isArray(config.projectMappings) && config.projectMappings.length > 0
      ? config.projectMappings.map(normalizeProjectMapping).filter((entry) => entry.id)
      : defaults.projectMappings.map(normalizeProjectMapping)
  };
}

export async function ensureAutomationRuntimeDirs() {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(runtimeLogsDir, { recursive: true });
  await mkdir(runtimeArtifactsDir, { recursive: true });
  await mkdir(runtimeTempDir, { recursive: true });
}

export async function loadAutomationConfig() {
  await ensureAutomationRuntimeDirs();
  await mkdir(dirname(runtimeConfigPath), { recursive: true });
  const launcherProfiles = await readLauncherProfiles();
  try {
    const raw = await readFile(runtimeConfigPath, "utf8");
    return normalizeConfig(JSON.parse(raw), launcherProfiles);
  } catch {
    const config = buildDefaultConfig(launcherProfiles);
    await writeFile(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return normalizeConfig(config, launcherProfiles);
  }
}

export async function saveAutomationConfig(config) {
  await ensureAutomationRuntimeDirs();
  const launcherProfiles = await readLauncherProfiles();
  const normalized = normalizeConfig(config, launcherProfiles);
  await writeFile(runtimeConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}
