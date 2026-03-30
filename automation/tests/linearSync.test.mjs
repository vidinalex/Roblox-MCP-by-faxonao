import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHubStore } from "../task-hub/store.mjs";
import { LinearSyncService } from "../linear-sync/sync.mjs";

describe("LinearSyncService", () => {
  let tempRoot;
  let store;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "rbxmcp-automation-linear-"));
    const launcherProfilesPath = join(tempRoot, "launcher", "profiles.json");
    await mkdir(join(tempRoot, "launcher"), { recursive: true });
    await writeFile(launcherProfilesPath, JSON.stringify({ profiles: [] }), "utf8");
    store = new TaskHubStore({
      dbPath: join(tempRoot, "automation.sqlite"),
      launcherProfilesPath
    });
    await store.bootstrap();
  });

  afterEach(async () => {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("imports filtered issues into router", async () => {
    const router = {
      handleLinearEvent: vi.fn(async () => {})
    };
    const service = new LinearSyncService({
      config: {
        enabled: true,
        apiKey: "token",
        pollIntervalMs: 1000,
        teamIds: ["team-1"],
        projectIds: [],
        labelNames: [],
        stateNames: []
      },
      store,
      router
    });
    service.client = {
      fetchRecentIssues: vi.fn(async () => ({
        pageInfo: { endCursor: "cursor-1" },
        nodes: [
          {
            id: "issue-1",
            identifier: "ABC-1",
            title: "Issue one",
            description: "Body",
            url: "https://linear.app",
            updatedAt: new Date().toISOString(),
            team: { id: "team-1", name: "Team" },
            project: { id: "project-1", name: "Proj" },
            state: { id: "state-1", name: "Todo" },
            labels: { nodes: [] }
          },
          {
            id: "issue-2",
            identifier: "ABC-2",
            title: "Issue two",
            description: "Body",
            url: "https://linear.app",
            updatedAt: new Date().toISOString(),
            team: { id: "team-2", name: "Team" },
            project: { id: "project-1", name: "Proj" },
            state: { id: "state-1", name: "Todo" },
            labels: { nodes: [] }
          }
        ]
      }))
    };

    await service.syncOnce();
    expect(router.handleLinearEvent).toHaveBeenCalledTimes(1);
    expect(store.getRuntimeMeta("linear.cursor", {}).endCursor).toBe("cursor-1");
  });
});
