import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHubStore } from "../task-hub/store.mjs";
import { TaskRouter } from "../task-hub/router.mjs";

describe("TaskRouter", () => {
  let tempRoot;
  let store;
  let notifier;
  let workerService;
  let router;
  let linearTools;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "rbxmcp-automation-router-"));
    const launcherProfilesPath = join(tempRoot, "launcher", "profiles.json");
    await mkdir(join(tempRoot, "launcher"), { recursive: true });
    await writeFile(launcherProfilesPath, JSON.stringify({
      profiles: [
        {
          id: "project-5111",
          name: "PlantsVS",
          workspacePath: "C:\\Repo",
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
    workerService = {
      runTriage: vi.fn(async () => {}),
      runExecution: vi.fn(async () => {})
    };
    linearTools = {
      syncNow: vi.fn(async () => []),
      listImportedTasks: vi.fn(() => [])
    };
    router = new TaskRouter({
      store,
      workerService,
      projectMappings: [
        {
          id: "project-5111",
          launcherProfileId: "project-5111",
          name: "PlantsVS",
          port: "5111",
          expectedPlaceId: "83003959412113",
          telegramChatId: "123"
        }
      ],
      notifier,
      linearTools
    });
  });

  afterEach(async () => {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates task from telegram and triggers triage", async () => {
    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "99",
      text: "\u0421\u0434\u0435\u043B\u0430\u0439 \u043D\u043E\u0432\u044B\u0439 \u0448\u043E\u043F",
      username: "vidin"
    });
    const task = store.getTask(result.taskId);
    expect(result.action).toBe("created");
    expect(task.projectProfileId).toBe("project-5111");
    expect(workerService.runTriage).toHaveBeenCalledWith(task.id);
  });

  test("routes clarification to existing task", async () => {
    const task = store.createTask({
      source: "telegram",
      title: "Need clarification",
      description: "Question",
      state: "needs_clarification"
    });
    store.upsertLink(task.id, {
      linkType: "telegram_chat",
      externalId: "123"
    });
    store.replaceOpenQuestions(task.id, ["What place?"]);

    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "100",
      text: "\u041F\u043E\u0440\u0442 5111"
    });

    expect(result.action).toBe("clarification_recorded");
    expect(store.listOpenQuestions(task.id)).toHaveLength(0);
    expect(workerService.runTriage).toHaveBeenCalledWith(task.id);
  });

  test("runs execution only from explicit run command", async () => {
    const task = store.createTask({
      source: "telegram",
      title: "Ready task",
      description: "Exec",
      state: "ready_for_execution"
    });
    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "101",
      text: `run ${task.id}`
    });
    expect(result.action).toBe("execution_started");
    expect(workerService.runExecution).toHaveBeenCalledWith(task.id);
  });

  test("treats bare task id as status lookup instead of clarification", async () => {
    const clarificationTask = store.createTask({
      source: "telegram",
      title: "Need clarification",
      description: "Question",
      state: "needs_clarification"
    });
    store.upsertLink(clarificationTask.id, {
      linkType: "telegram_chat",
      externalId: "123"
    });
    store.replaceOpenQuestions(clarificationTask.id, ["What place?"]);

    const targetTask = store.createTask({
      id: "T-00048",
      source: "linear",
      title: "Linear task",
      description: "Imported task",
      state: "blocked_manual",
      blockedReason: "fetch failed"
    });

    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "102",
      text: "T-00048"
    });

    expect(result.action).toBe("status_reported");
    expect(workerService.runTriage).not.toHaveBeenCalled();
    expect(store.listOpenQuestions(clarificationTask.id)).toHaveLength(1);
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      taskId: targetTask.id,
      text: expect.stringContaining("State: blocked_manual")
    }));
  });

  test("updates model settings from telegram command", async () => {
    const getCodexSettings = vi.fn(() => ({
      model: "gpt-5-codex",
      reasoningEffort: "medium"
    }));
    const setCodexSettings = vi.fn(async (patch) => ({
      model: patch.model,
      reasoningEffort: patch.reasoningEffort
    }));
    router = new TaskRouter({
      store,
      workerService,
      projectMappings: [],
      notifier,
      linearTools,
      getCodexSettings,
      setCodexSettings
    });

    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "103",
      text: "model gpt-5.4 high"
    });

    expect(result.action).toBe("model_updated");
    expect(setCodexSettings).toHaveBeenCalledWith({
      model: "gpt-5.4",
      reasoningEffort: "high"
    });
  });

  test("routes linear trigger word to linear intent instead of task creation", async () => {
    const linearTask = store.createTask({
      source: "linear",
      sourceRef: "MAR-12",
      title: "Simple shop bug",
      description: "Fix simple shop bug",
      state: "needs_triage"
    });
    store.upsertLink(linearTask.id, {
      linkType: "linear_issue",
      externalId: "issue-1",
      externalUrl: "https://linear.app",
      meta: {
        identifier: "MAR-12"
      }
    });
    linearTools.syncNow.mockResolvedValue([linearTask]);
    linearTools.listImportedTasks.mockReturnValue([linearTask]);

    const result = await router.handleTelegramEvent({
      chatId: "123",
      messageId: "104",
      text: "\u0443 \u0442\u0435\u0431\u044F \u0435\u0441\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043B\u0430\u0439\u043D\u0438\u0440\u0443? \u043D\u0430\u0439\u0434\u0438 \u043C\u043D\u0435 \u043F\u0440\u043E\u0441\u0442\u0443\u044E \u0442\u0430\u0441\u043A\u0443"
    });

    expect(result.action).toBe("linear_list");
    expect(linearTools.syncNow).toHaveBeenCalled();
    expect(workerService.runTriage).not.toHaveBeenCalled();
    expect(store.listTasks({ source: "telegram" })).toHaveLength(0);
  });
});
