import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function sanitizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizePort(value) {
  const raw = String(value ?? "").trim();
  const numeric = Number.parseInt(raw, 10);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 65535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return String(numeric);
}

function normalizePlaceId(value) {
  const text = sanitizeText(value);
  if (!text) {
    return "";
  }
  if (!/^\d+$/.test(text)) {
    throw new Error("expectedPlaceId must contain only digits.");
  }
  return text;
}

function normalizeWorkspacePath(value) {
  const text = sanitizeText(value);
  if (!text) {
    throw new Error("workspacePath is required.");
  }
  return text;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return value === true;
}

function normalizeLastUsedAt(value) {
  const text = sanitizeText(value);
  return text || new Date(0).toISOString();
}

export function normalizeProfile(input, defaults = {}) {
  return {
    id: sanitizeText(input.id, defaults.id || randomUUID()),
    name: sanitizeText(input.name, defaults.name || "Untitled Project"),
    workspacePath: normalizeWorkspacePath(input.workspacePath ?? defaults.workspacePath),
    port: normalizePort(input.port ?? defaults.port),
    expectedPlaceId: normalizePlaceId(input.expectedPlaceId ?? defaults.expectedPlaceId),
    stdioMode: "off",
    autoStart: normalizeBoolean(input.autoStart, defaults.autoStart ?? false),
    favorite: normalizeBoolean(input.favorite, defaults.favorite ?? false),
    lastUsedAt: normalizeLastUsedAt(input.lastUsedAt ?? defaults.lastUsedAt)
  };
}

export class LauncherProfileStore {
  constructor(options) {
    this.filePath = options.filePath;
    this.defaultWorkspacePath = options.defaultWorkspacePath;
  }

  async ensureFile() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await writeFile(this.filePath, JSON.stringify({ profiles: [] }, null, 2), "utf8");
    }
  }

  async readAll() {
    await this.ensureFile();
    const raw = await readFile(this.filePath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.map((profile) => normalizeProfile(profile)) : [];
      return { profiles };
    } catch {
      return { profiles: [] };
    }
  }

  async writeAll(data) {
    await this.ensureFile();
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async listProfiles() {
    const data = await this.readAll();
    return [...data.profiles].sort((left, right) => {
      if (left.favorite !== right.favorite) {
        return left.favorite ? -1 : 1;
      }
      return String(right.lastUsedAt).localeCompare(String(left.lastUsedAt));
    });
  }

  async getProfile(id) {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => profile.id === id) ?? null;
  }

  validatePortUniqueness(profiles, port, ignoreId = null) {
    const conflict = profiles.find((profile) => profile.port === port && profile.id !== ignoreId);
    if (conflict) {
      throw new Error(`Port ${port} is already assigned to "${conflict.name}".`);
    }
  }

  async createProfile(input) {
    const data = await this.readAll();
    const profile = normalizeProfile(input, {
      workspacePath: this.defaultWorkspacePath,
      port: "5100",
      expectedPlaceId: "",
      name: "New Project"
    });
    this.validatePortUniqueness(data.profiles, profile.port);
    data.profiles.push(profile);
    await this.writeAll(data);
    return profile;
  }

  async updateProfile(id, patch) {
    const data = await this.readAll();
    const index = data.profiles.findIndex((profile) => profile.id === id);
    if (index === -1) {
      throw new Error(`Profile "${id}" not found.`);
    }
    const next = normalizeProfile({
      ...data.profiles[index],
      ...patch,
      id
    });
    this.validatePortUniqueness(data.profiles, next.port, id);
    data.profiles[index] = next;
    await this.writeAll(data);
    return next;
  }

  async deleteProfile(id) {
    const data = await this.readAll();
    const nextProfiles = data.profiles.filter((profile) => profile.id !== id);
    if (nextProfiles.length === data.profiles.length) {
      throw new Error(`Profile "${id}" not found.`);
    }
    await this.writeAll({ profiles: nextProfiles });
  }

  async duplicateProfile(id) {
    const source = await this.getProfile(id);
    if (!source) {
      throw new Error(`Profile "${id}" not found.`);
    }
    const existing = await this.listProfiles();
    const nextPort = this.findNextOpenPort(existing.map((profile) => profile.port), Number.parseInt(source.port, 10) + 1);
    const duplicate = normalizeProfile({
      ...source,
      id: randomUUID(),
      name: `${source.name} Copy`,
      port: String(nextPort),
      favorite: false,
      lastUsedAt: new Date().toISOString()
    });
    existing.push(duplicate);
    await this.writeAll({ profiles: existing });
    return duplicate;
  }

  findNextOpenPort(ports, startPort = 5100) {
    const occupied = new Set(ports.map((port) => String(port)));
    let next = startPort;
    while (occupied.has(String(next))) {
      next += 1;
    }
    return next;
  }
}
