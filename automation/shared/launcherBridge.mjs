function buildJsonHeaders() {
  return {
    "Content-Type": "application/json"
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class LauncherBridge {
  constructor(options) {
    this.controlBaseUrl = options.controlBaseUrl.replace(/\/+$/, "");
  }

  async request(path, init = {}) {
    const response = await fetch(`${this.controlBaseUrl}${path}`, init);
    const body = await readJson(response);
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `Launcher request failed for ${path}`);
    }
    return body;
  }

  async resolveByPort(port) {
    return await this.request("/resolve-by-port", {
      method: "POST",
      headers: buildJsonHeaders(),
      body: JSON.stringify({ port: String(port) })
    });
  }

  async listProfiles() {
    const response = await this.request("/profiles");
    return response.profiles || [];
  }

  async ensureProfile(id) {
    return await this.request(`/profiles/${id}/start`, {
      method: "POST",
      headers: buildJsonHeaders(),
      body: "{}"
    });
  }

  async getMcpHealth(port) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: controller.signal
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(`MCP healthz returned ${response.status}`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureTaskReady(profile, options = {}) {
    if (!profile) {
      return {
        ok: false,
        reason: "No launcher profile is attached to this task.",
        action: "Assign a project profile before execution."
      };
    }
    try {
      await this.ensureProfile(profile.id);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        action: `Start launcher profile ${profile.name}.`
      };
    }
    let health;
    try {
      health = await this.getMcpHealth(profile.port);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        action: `Open launcher profile ${profile.name} and wait for MCP health on port ${profile.port}.`
      };
    }
    if (profile.expectedPlaceId && String(health.expectedPlaceId || "") !== String(profile.expectedPlaceId)) {
      return {
        ok: false,
        reason: `Expected placeId ${profile.expectedPlaceId}, got ${health.expectedPlaceId || "-"}.`,
        action: `Reconnect Studio to place ${profile.expectedPlaceId} on port ${profile.port}.`
      };
    }
    if (options.requiresStudio && health.studioOnline !== true) {
      return {
        ok: false,
        reason: "Studio is offline.",
        action: `Open Studio for ${profile.name}, connect the plugin on port ${profile.port}, then reply ready.`
      };
    }
    if (options.requiresWrite && health.scriptWriteOk !== true) {
      return {
        ok: false,
        reason: "Script write path is not ready.",
        action: `Keep Studio connected for ${profile.name} and wait until write readiness is green.`
      };
    }
    return {
      ok: true,
      profile,
      health
    };
  }
}
