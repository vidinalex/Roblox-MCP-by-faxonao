import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHubStore } from "../task-hub/store.mjs";
import { AutomationWorkerService } from "../workers/service.mjs";

describe("AutomationWorkerService", () => {
  let tempRoot;
  let store;
  let notifier;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "rbxmcp-automation-worker-"));
    const launcherProfilesPath = join(tempRoot, "launcher", "profiles.json");
    await mkdir(join(tempRoot, "launcher"), { recursive: true });
    await writeFile(launcherProfilesPath, JSON.stringify({
      profiles: [
        {
          id: "project-5111",
          name: "PlantsVS",
          workspacePath: tempRoot,
          port: "5111",
          expectedPlaceId: "83003959412113"
        }
      ]
    }), "utf8");
    store = new TaskHubStore({
      dbPath: join(tempRoot, "automation.sqlite"),
      launcherProfilesPath
    });
    await store.bootstrap();
    notifier = {
      send: vi.fn(async () => {})
    };
  });

  afterEach(async () => {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("moves task to ready_for_execution on successful triage", async () => {
    const task = store.createTask({
      source: "telegram",
      title: "Shop task",
      description: "Need shop fix",
      projectProfileId: "project-5111",
      state: "needs_triage"
    });
    store.upsertLink(task.id, { linkType: "telegram_chat", externalId: "123" });

    const service = new AutomationWorkerService({
      store,
      adapter: {
        config: { runtime: "mock" },
        run: vi.fn(async () => ({
          raw: {
            normalizedTitle: "Shop task",
            taskType: "feature",
            projectProfileId: "project-5111",
            requiresStudio: true,
            requiresManualVerification: true,
            triageSummary: "Ready.",
            acceptanceCriteria: ["Works"],
            executorPrompt: "Do the work",
            questions: [],
            recommendedState: "ready_for_execution"
          }
        }))
      },
      launcherBridge: {
        ensureTaskReady: vi.fn(async () => ({ ok: true })),
        getMcpHealth: vi.fn(async () => ({ studioOnline: true }))
      },
      artifactsDir: join(tempRoot, "artifacts"),
      projectMappings: [{ launcherProfileId: "project-5111", workspacePath: tempRoot }],
      notifier
    });

    await service.runTriage(task.id);
    expect(store.getTask(task.id).state).toBe("ready_for_execution");
  });

  test("blocks execution when launcher readiness fails", async () => {
    const task = store.createTask({
      source: "telegram",
      title: "Live write",
      description: "Do live write",
      projectProfileId: "project-5111",
      state: "ready_for_execution",
      requiresStudio: true
    });
    store.upsertLink(task.id, { linkType: "telegram_chat", externalId: "123" });

    const service = new AutomationWorkerService({
      store,
      adapter: {
        config: { runtime: "mock" },
        run: vi.fn(async () => ({ raw: {} }))
      },
      launcherBridge: {
        ensureTaskReady: vi.fn(async () => ({
          ok: false,
          reason: "Studio offline",
          action: "Open Studio"
        })),
        getMcpHealth: vi.fn(async () => ({}))
      },
      artifactsDir: join(tempRoot, "artifacts"),
      projectMappings: [{ launcherProfileId: "project-5111", workspacePath: tempRoot }],
      notifier
    });

    await service.runExecution(task.id);
    expect(store.getTask(task.id).state).toBe("blocked_manual");
    expect(store.getTask(task.id).blockedReason).toBe("Studio offline");
  });
});
