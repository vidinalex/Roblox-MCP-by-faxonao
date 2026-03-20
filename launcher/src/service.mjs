import { defaultWorkspacePath, launcherProfilesPath, launcherRuntimePath } from "./constants.mjs";
import { LauncherProfileStore } from "./profileStore.mjs";
import { LauncherSupervisor } from "./supervisor.mjs";

function serializeRuntime(runtime) {
  if (!runtime) {
    return null;
  }
  return {
    profileId: runtime.profileId ?? null,
    pid: runtime.pid ?? null,
    managed: runtime.managed === true,
    adopted: runtime.adopted === true,
    status: runtime.status || "stopped",
    starting: runtime.starting === true,
    logPath: runtime.logPath || null,
    lastHealth: runtime.lastHealth || null,
    lastTransitionAt: runtime.lastTransitionAt || null,
    lastError: runtime.lastError || null
  };
}

function serializeProfile(profile, runtime = null) {
  return {
    ...profile,
    runtime: serializeRuntime(runtime),
    status: runtime?.status || "stopped"
  };
}

export class LauncherService {
  constructor(options = {}) {
    this.profileStore = options.profileStore || new LauncherProfileStore({
      filePath: options.profilesPath || launcherProfilesPath,
      defaultWorkspacePath: options.defaultWorkspacePath || defaultWorkspacePath
    });
    this.supervisor = options.supervisor || new LauncherSupervisor({
      runtimePath: options.runtimePath || launcherRuntimePath
    });
  }

  async bootstrap() {
    await this.profileStore.ensureFile();
    await this.supervisor.bootstrap();
    const profiles = await this.profileStore.listProfiles();
    await this.supervisor.refreshAllStatuses(profiles);
    for (const profile of profiles) {
      if (profile.autoStart) {
        await this.supervisor.ensureProfile(profile).catch(() => {});
      }
    }
  }

  async dispose() {
    await this.supervisor.stopAllManaged();
    await this.supervisor.dispose();
  }

  async listProfiles() {
    const profiles = await this.profileStore.listProfiles();
    const statuses = await Promise.all(profiles.map((profile) => this.supervisor.refreshProfileStatus(profile)));
    return profiles.map((profile, index) => serializeProfile(profile, statuses[index]));
  }

  async getState() {
    return {
      generatedAt: new Date().toISOString(),
      defaultWorkspacePath,
      profiles: await this.listProfiles()
    };
  }

  async getProfileOrThrow(id) {
    const profile = await this.profileStore.getProfile(id);
    if (!profile) {
      throw new Error(`Profile "${id}" not found.`);
    }
    return profile;
  }

  async createProfile(input) {
    const profile = await this.profileStore.createProfile(input);
    const runtime = await this.supervisor.refreshProfileStatus(profile);
    return serializeProfile(profile, runtime);
  }

  async updateProfile(id, patch) {
    const profile = await this.profileStore.updateProfile(id, patch);
    const runtime = await this.supervisor.refreshProfileStatus(profile);
    return serializeProfile(profile, runtime);
  }

  async deleteProfile(id) {
    const profile = await this.getProfileOrThrow(id);
    await this.supervisor.stopProfile(profile, { force: true }).catch(() => {});
    await this.profileStore.deleteProfile(id);
  }

  async duplicateProfile(id) {
    const profile = await this.profileStore.duplicateProfile(id);
    const runtime = await this.supervisor.refreshProfileStatus(profile);
    return serializeProfile(profile, runtime);
  }

  async startProfile(id) {
    const profile = await this.getProfileOrThrow(id);
    await this.profileStore.updateProfile(id, { lastUsedAt: new Date().toISOString() });
    const runtime = await this.supervisor.startProfile(profile);
    return serializeRuntime(runtime);
  }

  async stopProfile(id, options = {}) {
    const profile = await this.getProfileOrThrow(id);
    return await this.supervisor.stopProfile(profile, options);
  }

  async restartProfile(id) {
    const profile = await this.getProfileOrThrow(id);
    await this.profileStore.updateProfile(id, { lastUsedAt: new Date().toISOString() });
    const runtime = await this.supervisor.restartProfile(profile);
    return serializeRuntime(runtime);
  }

  async ensureProfile(id) {
    const profile = await this.getProfileOrThrow(id);
    await this.profileStore.updateProfile(id, { lastUsedAt: new Date().toISOString() });
    const runtime = await this.supervisor.ensureProfile(profile);
    return serializeRuntime(runtime);
  }

  async resolveByPort(port) {
    const profiles = await this.profileStore.listProfiles();
    const profile = profiles.find((entry) => entry.port === String(port)) || null;
    if (!profile) {
      return { found: false, profile: null, status: null };
    }
    const status = await this.supervisor.refreshProfileStatus(profile);
    return { found: true, profile: serializeProfile(profile, status), status: serializeRuntime(status) };
  }

  async tailProfileLogs(id) {
    const profile = await this.getProfileOrThrow(id);
    return await this.supervisor.tailProfileLogs(profile);
  }

  async tailAllLogs() {
    const profiles = await this.profileStore.listProfiles();
    const logSets = await Promise.all(profiles.map(async (profile) => ({
      profile,
      logs: await this.supervisor.tailProfileLogs(profile)
    })));
    const lines = logSets
      .flatMap(({ profile, logs }) => logs.lines.map((line) => ({
        profileName: profile.name,
        logPath: logs.logPath,
        raw: line
      })))
      .sort((left, right) => left.raw.localeCompare(right.raw))
      .slice(-240)
      .map((entry) => `[${entry.profileName}] ${entry.raw}`);
    return {
      profileCount: profiles.length,
      lines
    };
  }

  async buildAiPrompt(id) {
    const profile = await this.getProfileOrThrow(id);
    const runtime = await this.supervisor.refreshProfileStatus(profile);
    const placeId = profile.expectedPlaceId || runtime.lastHealth?.body?.expectedPlaceId || runtime.lastHealth?.body?.placeId || "-";
    return [
      `RBXMCP project profile: ${profile.name}`,
      `Workspace: ${profile.workspacePath}`,
      `Bridge base URL: http://127.0.0.1:${profile.port}`,
      `Expected placeId: ${placeId}`,
      `Launcher status: ${runtime.status}`,
      "",
      "Agent rules:",
      "- Use slash-delimited public paths like Service/Folder/Script.",
      "- Check /v1/agent/health before writes.",
      "- Use /v1/agent/schema for exact request/response contracts.",
      "- For large writes, stop waiting after 30 seconds and inspect requestId via /v1/agent/get_request_trace.",
      "- On Windows, avoid giant inline PowerShell payloads; use file-based wrappers in tools/ when needed."
    ].join("\n");
  }

  async copyDiagnostics(id) {
    const profile = await this.getProfileOrThrow(id);
    const runtime = await this.supervisor.refreshProfileStatus(profile);
    return [
      `Profile: ${profile.name}`,
      `Workspace: ${profile.workspacePath}`,
      `Port: ${profile.port}`,
      `Expected placeId: ${profile.expectedPlaceId || "-"}`,
      `Status: ${runtime.status}`,
      `PID: ${runtime.pid || "-"}`,
      `Managed: ${runtime.managed === true ? "yes" : "no"}`,
      `Studio online: ${runtime.lastHealth?.body?.studioOnline === true ? "yes" : "no"}`,
      `Write path: ${runtime.lastHealth?.body?.scriptWriteOk === true ? "ready" : "not_ready"}`,
      `Health latency: ${runtime.lastHealth?.latencyMs ?? "-"}ms`,
      `Last error: ${runtime.lastError || "-"}`
    ].join("\n");
  }
}
