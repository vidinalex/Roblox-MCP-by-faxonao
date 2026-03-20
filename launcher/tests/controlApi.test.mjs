import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createLauncherControlApp } from "../src/controlApi.mjs";

describe("createLauncherControlApp", () => {
  it("resolves profile by port", async () => {
    const service = {
      listProfiles: vi.fn(async () => []),
      createProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      startProfile: vi.fn(),
      stopProfile: vi.fn(),
      restartProfile: vi.fn(),
      resolveByPort: vi.fn(async () => ({
        found: true,
        profile: { id: "a", port: "5111", name: "Arena" },
        status: { status: "online" }
      }))
    };
    const app = createLauncherControlApp(service);
    const response = await request(app).post("/launcher/resolve-by-port").send({ port: "5111" });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.profile.name).toBe("Arena");
  });

  it("starts and stops profiles", async () => {
    const service = {
      listProfiles: vi.fn(async () => []),
      createProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      startProfile: vi.fn(async () => ({ status: "online" })),
      stopProfile: vi.fn(async () => ({ stopped: true })),
      restartProfile: vi.fn(async () => ({ status: "online" })),
      resolveByPort: vi.fn()
    };
    const app = createLauncherControlApp(service);
    const start = await request(app).post("/launcher/profiles/a/start");
    expect(start.body.runtime.status).toBe("online");
    const stop = await request(app).post("/launcher/profiles/a/stop");
    expect(stop.body.result.stopped).toBe(true);
  });
});
