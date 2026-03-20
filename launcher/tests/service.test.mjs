import { describe, expect, it, vi } from "vitest";
import { LauncherService } from "../src/service.mjs";

function createProfile() {
  return {
    id: "profile-1",
    name: "Arena",
    workspacePath: "C:\\repo",
    port: "5111",
    expectedPlaceId: "83003959412113",
    favorite: false,
    autoStart: false,
    lastUsedAt: null
  };
}

function createRuntime() {
  return {
    profileId: "profile-1",
    pid: 4242,
    managed: true,
    adopted: false,
    starting: false,
    status: "online",
    logPath: "C:\\repo\\.rbxmcp\\launcher\\logs\\5111.log",
    lastHealth: { healthy: true, body: { studioOnline: true } },
    lastTransitionAt: "2026-03-20T00:00:00.000Z",
    lastError: null,
    child: { impossible: true },
    stream: { impossible: true }
  };
}

describe("LauncherService", () => {
  it("serializes runtime objects for ipc-safe responses", async () => {
    const profile = createProfile();
    const runtime = createRuntime();
    const profileStore = {
      ensureFile: vi.fn(),
      listProfiles: vi.fn(async () => [profile]),
      getProfile: vi.fn(async () => profile),
      updateProfile: vi.fn(async () => profile)
    };
    const supervisor = {
      bootstrap: vi.fn(),
      dispose: vi.fn(),
      refreshAllStatuses: vi.fn(),
      refreshProfileStatus: vi.fn(async () => runtime),
      startProfile: vi.fn(async () => runtime),
      restartProfile: vi.fn(async () => runtime)
    };
    const service = new LauncherService({ profileStore, supervisor });

    const state = await service.getState();
    expect(state.profiles[0].runtime.child).toBeUndefined();
    expect(state.profiles[0].runtime.stream).toBeUndefined();

    const started = await service.startProfile(profile.id);
    expect(started.child).toBeUndefined();
    expect(started.stream).toBeUndefined();

    const restarted = await service.restartProfile(profile.id);
    expect(restarted.child).toBeUndefined();
    expect(restarted.stream).toBeUndefined();
  });

  it("builds ai prompt and aggregates logs across profiles", async () => {
    const profile = createProfile();
    const secondProfile = { ...createProfile(), id: "profile-2", name: "Shop", port: "5009", expectedPlaceId: "104217426530353" };
    const runtime = createRuntime();
    const profileStore = {
      ensureFile: vi.fn(),
      listProfiles: vi.fn(async () => [profile, secondProfile]),
      getProfile: vi.fn(async (id) => [profile, secondProfile].find((item) => item.id === id) ?? null),
      updateProfile: vi.fn(async () => profile)
    };
    const supervisor = {
      bootstrap: vi.fn(),
      dispose: vi.fn(),
      refreshAllStatuses: vi.fn(),
      refreshProfileStatus: vi.fn(async () => runtime),
      tailProfileLogs: vi.fn(async (entry) => ({
        logPath: `C:\\logs\\${entry.port}.log`,
        lines: [`[2026-03-20T00:00:00.000Z] ${entry.name} ready`]
      }))
    };
    const service = new LauncherService({ profileStore, supervisor });

    const prompt = await service.buildAiPrompt(profile.id);
    expect(prompt).toContain("Bridge base URL: http://127.0.0.1:5111");
    expect(prompt).toContain("Expected placeId: 83003959412113");

    const logs = await service.tailAllLogs();
    expect(logs.profileCount).toBe(2);
    expect(logs.lines.some((line) => line.includes("[Arena]"))).toBe(true);
    expect(logs.lines.some((line) => line.includes("[Shop]"))).toBe(true);
  });
});
