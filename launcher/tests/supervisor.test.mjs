import { describe, expect, it, vi } from "vitest";
import { LauncherSupervisor } from "../src/supervisor.mjs";

function createProfile(overrides = {}) {
  return {
    id: "profile-1",
    name: "Arena",
    workspacePath: "C:\\repo",
    port: "5111",
    expectedPlaceId: "83003959412113",
    ...overrides
  };
}

describe("LauncherSupervisor", () => {
  it("adopts a healthy existing process", async () => {
    const supervisor = new LauncherSupervisor({
      probePort: vi.fn(async () => ({
        healthy: true,
        reachable: true,
        body: { expectedPlaceId: "83003959412113", studioOnline: true, scriptWriteOk: true, uiWriteOk: true }
      })),
      findListeningPids: vi.fn(async () => [4242])
    });
    await supervisor.bootstrap();
    const runtime = await supervisor.startProfile(createProfile());
    expect(runtime.adopted).toBe(true);
    expect(runtime.managed).toBe(false);
    expect(runtime.status).toBe("online");
  });

  it("starts a new managed process when port is free", async () => {
    let attempts = 0;
    const child = {
      pid: 9090,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      on: vi.fn(),
      kill: vi.fn()
    };
    const supervisor = new LauncherSupervisor({
      startupTimeoutMs: 1000,
      probePort: vi.fn(async () => {
        attempts += 1;
        if (attempts < 2) {
          return { healthy: false, reachable: false };
        }
        return {
          healthy: true,
          reachable: true,
          body: { expectedPlaceId: "83003959412113", studioOnline: true, scriptWriteOk: true, uiWriteOk: true }
        };
      }),
      findListeningPids: vi.fn(async () => []),
      spawnProfileProcess: vi.fn(() => ({ child, stream: { end: vi.fn() } }))
    });
    await supervisor.bootstrap();
    const runtime = await supervisor.startProfile(createProfile());
    expect(runtime.managed).toBe(true);
    expect(runtime.status).toBe("online");
  });

  it("marks occupied unhealthy port as conflict", async () => {
    const supervisor = new LauncherSupervisor({
      probePort: vi.fn(async () => ({ healthy: false, reachable: false })),
      findListeningPids: vi.fn(async () => [2222])
    });
    await supervisor.bootstrap();
    await expect(supervisor.startProfile(createProfile())).rejects.toThrow("Port 5111");
  });

  it("does not stop external process without force", async () => {
    const supervisor = new LauncherSupervisor({
      probePort: vi.fn(async () => ({
        healthy: true,
        reachable: true,
        body: { expectedPlaceId: "83003959412113", studioOnline: true, scriptWriteOk: true, uiWriteOk: true }
      })),
      findListeningPids: vi.fn(async () => [4242])
    });
    await supervisor.bootstrap();
    await supervisor.startProfile(createProfile());
    const result = await supervisor.stopProfile(createProfile());
    expect(result.reason).toBe("external_process");
  });

  it("surfaces spawn failure and clears starting state", async () => {
    const supervisor = new LauncherSupervisor({
      probePort: vi.fn(async () => ({ healthy: false, reachable: false })),
      findListeningPids: vi.fn(async () => []),
      spawnProfileProcess: vi.fn(() => {
        throw new Error("spawn EINVAL");
      })
    });
    await supervisor.bootstrap();
    await expect(supervisor.startProfile(createProfile())).rejects.toThrow("spawn EINVAL");
    const runtime = supervisor.getRuntime("profile-1");
    expect(runtime?.status).toBe("stopped");
    expect(runtime?.starting).toBe(false);
    expect(runtime?.lastError).toBe("spawn EINVAL");
  });
});
