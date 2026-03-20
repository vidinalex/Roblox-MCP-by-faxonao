import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { launcherLogsDir, launcherRuntimePath, healthTimeoutMs, maxLogTailLines, refreshIntervalMs, startupTimeoutMs } from "./constants.mjs";

async function probePort(port, timeoutMs = healthTimeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: "GET",
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    return {
      reachable: true,
      statusCode: response.status,
      body,
      healthy: response.ok && !!body,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      reachable: false,
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

function statusFromHealth(runtime, health, listeningPids, expectedPlaceId) {
  if (runtime.starting && !health.healthy) {
    return "starting";
  }
  if (health.healthy) {
    const actualPlaceId = String(health.body?.expectedPlaceId ?? health.body?.placeId ?? "");
    if (expectedPlaceId && actualPlaceId && actualPlaceId !== expectedPlaceId) {
      return "port_conflict";
    }
    const writesOk = health.body?.scriptWriteOk !== false && health.body?.uiWriteOk !== false;
    const studioOnline = health.body?.studioOnline !== false;
    return writesOk && studioOnline ? "online" : "degraded";
  }
  if (Array.isArray(listeningPids) && listeningPids.length > 0) {
    return runtime.managed ? "hung" : "port_conflict";
  }
  return "stopped";
}

async function findListeningPids(port) {
  return await new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const pids = stdout
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((value) => Number.isFinite(value));
      resolve(pids);
    });
  });
}

async function killProcessTree(pid) {
  await new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function buildSpawnCommand() {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd run dev"]
    };
  }
  return {
    command: "npm",
    args: ["run", "dev"]
  };
}

function spawnProfileProcess(profile, logPath) {
  const spawnCommand = buildSpawnCommand();
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    cwd: profile.workspacePath,
    windowsHide: true,
    env: {
      ...process.env,
      RBXMCP_PORT: profile.port,
      RBXMCP_EXPECT_PLACE_ID: profile.expectedPlaceId,
      RBXMCP_STDIO_MODE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stream = createWriteStream(logPath, { flags: "a" });
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  return { child, stream };
}

export class LauncherSupervisor {
  constructor(options = {}) {
    this.logsDir = options.logsDir || launcherLogsDir;
    this.runtimePath = options.runtimePath || launcherRuntimePath;
    this.probePort = options.probePort || probePort;
    this.findListeningPids = options.findListeningPids || findListeningPids;
    this.killProcessTree = options.killProcessTree || killProcessTree;
    this.spawnProfileProcess = options.spawnProfileProcess || spawnProfileProcess;
    this.refreshIntervalMs = options.refreshIntervalMs || refreshIntervalMs;
    this.startupTimeoutMs = options.startupTimeoutMs || startupTimeoutMs;
    this.now = options.now || (() => new Date().toISOString());
    this.runtimes = new Map();
    this.refreshTimer = null;
  }

  async bootstrap() {
    await mkdir(dirname(this.runtimePath), { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
    try {
      const raw = await readFile(this.runtimePath, "utf8");
      const parsed = JSON.parse(raw);
      const runtimes = parsed?.runtimes ?? {};
      for (const [profileId, runtime] of Object.entries(runtimes)) {
        this.runtimes.set(profileId, {
          ...runtime,
          child: null,
          stream: null
        });
      }
    } catch {
      await this.persistRuntime();
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshAllStatuses();
    }, this.refreshIntervalMs);
  }

  async dispose() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.persistRuntime();
  }

  getRuntime(profileId) {
    return this.runtimes.get(profileId) || null;
  }

  async persistRuntime() {
    const runtimes = {};
    for (const [profileId, runtime] of this.runtimes.entries()) {
      runtimes[profileId] = {
        profileId,
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
    await writeFile(this.runtimePath, JSON.stringify({ runtimes }, null, 2), "utf8");
  }

  buildLogPath(profile) {
    const safeName = basename(profile.workspacePath).replace(/[^\w.-]+/g, "_");
    return join(this.logsDir, `${profile.port}-${safeName}.log`);
  }

  async appendTransition(runtime, message) {
    if (!runtime.logPath) {
      return;
    }
    await appendFile(runtime.logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8").catch(() => {});
  }

  async adoptExisting(profile, health, listeningPids = []) {
    const runtime = {
      profileId: profile.id,
      pid: listeningPids[0] ?? null,
      managed: false,
      adopted: true,
      starting: false,
      status: statusFromHealth({ managed: false }, health, listeningPids, profile.expectedPlaceId),
      logPath: this.buildLogPath(profile),
      lastHealth: health,
      lastTransitionAt: this.now(),
      lastError: null,
      child: null,
      stream: null
    };
    this.runtimes.set(profile.id, runtime);
    await this.appendTransition(runtime, `Adopted existing MCP on port ${profile.port}.`);
    await this.persistRuntime();
    return runtime;
  }

  async startProfile(profile) {
    const health = await this.probePort(profile.port);
    const listeningPids = await this.findListeningPids(profile.port);
    if (health.healthy && statusFromHealth({ managed: false }, health, listeningPids, profile.expectedPlaceId) !== "port_conflict") {
      return await this.adoptExisting(profile, health, listeningPids);
    }
    if (listeningPids.length > 0 && !health.healthy) {
      const conflictRuntime = {
        profileId: profile.id,
        pid: listeningPids[0],
        managed: false,
        adopted: false,
        starting: false,
        status: "port_conflict",
        logPath: this.buildLogPath(profile),
        lastHealth: health,
        lastTransitionAt: this.now(),
        lastError: "Port is already listening but not healthy."
      };
      this.runtimes.set(profile.id, conflictRuntime);
      await this.persistRuntime();
      throw new Error(`Port ${profile.port} is already in use by another process.`);
    }

    const runtime = {
      profileId: profile.id,
      pid: null,
      managed: true,
      adopted: false,
      starting: true,
      status: "starting",
      logPath: this.buildLogPath(profile),
      lastHealth: null,
      lastTransitionAt: this.now(),
      lastError: null,
      child: null,
      stream: null
    };
    await mkdir(dirname(runtime.logPath), { recursive: true });
    this.runtimes.set(profile.id, runtime);
    let child;
    let stream;
    try {
      const spawned = this.spawnProfileProcess(profile, runtime.logPath);
      child = spawned.child;
      stream = spawned.stream;
    } catch (error) {
      runtime.starting = false;
      runtime.status = "stopped";
      runtime.lastTransitionAt = this.now();
      runtime.lastError = error instanceof Error ? error.message : String(error);
      await this.appendTransition(runtime, `Failed to spawn MCP: ${runtime.lastError}`);
      await this.persistRuntime();
      throw error;
    }
    runtime.child = child;
    runtime.stream = stream;
    runtime.pid = child.pid ?? null;
    child.on("error", async (error) => {
      runtime.child = null;
      runtime.stream?.end();
      runtime.stream = null;
      runtime.starting = false;
      runtime.status = "stopped";
      runtime.lastTransitionAt = this.now();
      runtime.lastError = error instanceof Error ? error.message : String(error);
      await this.appendTransition(runtime, `Spawn error: ${runtime.lastError}`);
      await this.persistRuntime();
    });
    child.on("exit", (code, signal) => {
      runtime.child = null;
      runtime.stream?.end();
      runtime.stream = null;
      runtime.starting = false;
      runtime.status = "stopped";
      runtime.lastTransitionAt = this.now();
      runtime.lastError = code === 0 ? null : `Process exited (${code ?? "null"} / ${signal ?? "null"}).`;
      void this.persistRuntime();
    });
    await this.appendTransition(runtime, `Spawned MCP for ${profile.name} on port ${profile.port}.`);
    await this.persistRuntime();
    return await this.waitUntilReady(profile);
  }

  async waitUntilReady(profile) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      const status = await this.refreshProfileStatus(profile);
      if (status.status === "online" || status.status === "degraded") {
        status.starting = false;
        await this.persistRuntime();
        return status;
      }
      if (status.status === "port_conflict") {
        throw new Error(`Profile ${profile.name} came up on conflicting port ${profile.port}.`);
      }
      await delay(500);
    }
    const runtime = this.getRuntime(profile.id);
    if (runtime) {
      runtime.starting = false;
      runtime.status = "hung";
      runtime.lastTransitionAt = this.now();
      runtime.lastError = "Startup timed out waiting for /healthz.";
      await this.appendTransition(runtime, runtime.lastError);
      await this.persistRuntime();
    }
    throw new Error(`Startup timed out for ${profile.name}.`);
  }

  async refreshProfileStatus(profile) {
    const runtime = this.getRuntime(profile.id) || {
      profileId: profile.id,
      managed: false,
      adopted: false,
      starting: false,
      status: "stopped",
      lastTransitionAt: this.now(),
      lastError: null,
      logPath: this.buildLogPath(profile)
    };
    const health = await this.probePort(profile.port);
    const listeningPids = await this.findListeningPids(profile.port);
    runtime.lastHealth = health;
    runtime.status = statusFromHealth(runtime, health, listeningPids, profile.expectedPlaceId);
    runtime.pid = runtime.pid ?? listeningPids[0] ?? null;
    runtime.lastTransitionAt = this.now();
    this.runtimes.set(profile.id, runtime);
    await this.persistRuntime();
    return runtime;
  }

  async refreshAllStatuses(profiles = []) {
    await Promise.allSettled(profiles.map((profile) => this.refreshProfileStatus(profile)));
  }

  async stopProfile(profile, options = {}) {
    const runtime = this.getRuntime(profile.id);
    if (!runtime) {
      return { stopped: false, reason: "not_running" };
    }
    if (!runtime.managed && !options.force) {
      return { stopped: false, reason: "external_process" };
    }
    const targetPid = runtime.pid;
    if (targetPid) {
      await this.killProcessTree(targetPid);
    }
    runtime.child?.kill?.();
    runtime.stream?.end();
    runtime.child = null;
    runtime.stream = null;
    runtime.pid = null;
    runtime.starting = false;
    runtime.status = "stopped";
    runtime.lastTransitionAt = this.now();
    runtime.lastError = null;
    await this.appendTransition(runtime, `Stopped MCP for ${profile.name}.`);
    await this.persistRuntime();
    return { stopped: true, reason: runtime.managed ? "managed_process" : "force_stopped" };
  }

  async restartProfile(profile) {
    await this.stopProfile(profile, { force: true });
    return await this.startProfile(profile);
  }

  async ensureProfile(profile) {
    const runtime = await this.refreshProfileStatus(profile);
    if (runtime.status === "online" || runtime.status === "degraded") {
      return runtime;
    }
    return await this.startProfile(profile);
  }

  async tailProfileLogs(profile) {
    const runtime = this.getRuntime(profile.id);
    const logPath = runtime?.logPath || this.buildLogPath(profile);
    try {
      const raw = await readFile(logPath, "utf8");
      const lines = raw.split(/\r?\n/);
      return {
        logPath,
        lines: lines.slice(-maxLogTailLines)
      };
    } catch {
      return {
        logPath,
        lines: []
      };
    }
  }

  async stopAllManaged() {
    const stopTasks = [];
    for (const [profileId, runtime] of this.runtimes.entries()) {
      if (!runtime.managed) {
        continue;
      }
      if (runtime.pid) {
        stopTasks.push(this.killProcessTree(runtime.pid).catch(() => {}));
      }
      runtime.status = "stopped";
      runtime.pid = null;
      runtime.child = null;
      runtime.stream?.end();
      runtime.stream = null;
      this.runtimes.set(profileId, runtime);
    }
    await Promise.allSettled(stopTasks);
    await this.persistRuntime();
  }
}
