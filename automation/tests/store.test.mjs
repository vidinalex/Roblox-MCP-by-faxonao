import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHubStore } from "../task-hub/store.mjs";

describe("TaskHubStore", () => {
  let tempRoot;
  let launcherProfilesPath;
  let dbPath;
  let store;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "rbxmcp-automation-store-"));
    launcherProfilesPath = join(tempRoot, "launcher", "profiles.json");
    dbPath = join(tempRoot, "automation.sqlite");
    await mkdir(join(tempRoot, "launcher"), { recursive: true });
    await writeFile(launcherProfilesPath, JSON.stringify({
      profiles: [
        {
          id: "profile-1",
          name: "Game A",
          workspacePath: "C:\\Repo",
          port: "5111",
          expectedPlaceId: "83003959412113",
          favorite: true
        }
      ]
    }), "utf8");
    store = new TaskHubStore({
      dbPath,
      launcherProfilesPath
    });
    await store.bootstrap();
  });

  afterEach(async () => {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates tasks and snapshots", () => {
    const task = store.createTask({
      source: "telegram",
      title: "Fix shop",
      description: "Need to fix the shop flow",
      projectProfileId: "profile-1",
      state: "needs_triage"
    });
    store.appendMessage(task.id, {
      source: "telegram",
      direction: "inbound",
      messageType: "task_request",
      body: "Need to fix the shop flow"
    });
    store.replaceOpenQuestions(task.id, ["Which project?", "Need live write?"]);

    const snapshot = store.getTaskSnapshot(task.id);
    expect(snapshot.task.id).toBe(task.id);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.questions).toHaveLength(2);
  });

  test("syncs launcher profiles", () => {
    const profiles = store.listProjectProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("profile-1");
    expect(profiles[0].port).toBe("5111");
  });

  test("records chat event lifecycle", () => {
    const event = store.createChatEvent({
      channel: "telegram",
      externalChatId: "123",
      externalMessageId: "900",
      status: "received",
      userText: "hello"
    });

    const updated = store.updateChatEvent(event.id, {
      status: "completed",
      action: "chat_answer",
      taskId: "T-00001",
      completedAt: "2026-03-20T12:00:00.000Z"
    });

    expect(updated.status).toBe("completed");
    expect(updated.action).toBe("chat_answer");
    expect(updated.taskId).toBe("T-00001");
    expect(store.getLatestChatEvent("telegram", "123").id).toBe(event.id);
    expect(store.listChatEvents("telegram", "123")).toHaveLength(1);
  });
});
