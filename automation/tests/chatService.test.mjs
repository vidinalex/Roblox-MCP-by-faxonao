import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskHubStore } from "../task-hub/store.mjs";
import { TelegramChatService } from "../chat/service.mjs";

describe("TelegramChatService", () => {
  let tempRoot;
  let store;
  let notifier;
  let router;
  let workerService;
  let adapter;
  let linear;
  let launcherBridge;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "rbxmcp-automation-chat-"));
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
    router = {
      handleTelegramEvent: vi.fn(async () => ({ ok: true, action: "fallback" })),
      handleLinearEvent: vi.fn(async (issue) => {
        const task = store.createTask({
          source: "linear",
          sourceRef: issue.identifier,
          title: issue.title,
          description: issue.description || issue.title,
          state: "needs_triage"
        });
        store.upsertLink(task.id, {
          linkType: "linear_issue",
          externalId: issue.id,
          externalUrl: issue.url || "",
          meta: {
            identifier: issue.identifier
          }
        });
        return { ok: true, taskId: task.id };
      })
    };
    workerService = {
      runTriage: vi.fn(async () => {}),
      runExecution: vi.fn(async () => {})
    };
    linear = {
      listLiveIssues: vi.fn(async () => []),
      searchLiveIssues: vi.fn(async () => []),
      getLiveIssue: vi.fn(async () => null)
    };
    launcherBridge = {
      listProfiles: vi.fn(async () => []),
      ensureProfile: vi.fn(async () => ({ ok: true })),
      getMcpHealth: vi.fn(async () => ({ studioOnline: true }))
    };
  });

  afterEach(async () => {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("returns linear suggestions conversationally and stores pending execution", async () => {
    store.createChatEvent({
      channel: "telegram",
      externalChatId: "123",
      externalMessageId: "900",
      status: "running",
      userText: "подбери простую задачу из linear"
    });
    const linearTask = store.createTask({
      id: "T-00048",
      source: "linear",
      sourceRef: "MAR-384",
      title: "Simple notification tweak",
      description: "Small change",
      state: "needs_triage"
    });
    store.upsertLink(linearTask.id, {
      linkType: "linear_issue",
      externalId: "issue-384",
      meta: {
        identifier: "MAR-384"
      }
    });
    linear.searchLiveIssues.mockResolvedValue([
      {
        id: "issue-384",
        identifier: "MAR-384",
        title: "Simple notification tweak",
        description: "Small change",
        url: "https://linear.app",
        teamName: "Marpla",
        projectName: "Fruits vs Brainrot",
        stateName: "Todo",
        labelNames: []
      }
    ]);

    adapter = {
      run: vi.fn()
        .mockResolvedValueOnce({
          raw: {
            responseMode: "task_suggestions",
            assistantMessage: "",
            finish: false,
            toolCalls: [
              {
                tool: "linear.searchIssues",
                argumentsJson: "{\"query\":\"простую таску\",\"limit\":3,\"ranking\":\"simple\"}"
              }
            ],
            taskMutation: {
              action: "none",
              taskId: "",
              title: "",
              description: "",
              intentType: "general",
              visibility: "hidden",
              projectProfileId: "",
              placeId: "",
              taskType: "general",
              lastUserGoal: ""
            },
            executionProposal: {
              kind: "none",
              taskId: "",
              linearIdentifier: "",
              summary: "",
              projectProfileId: "",
              candidateTaskIds: []
            }
          }
        })
        .mockResolvedValueOnce({
          raw: {
            responseMode: "task_suggestions",
            assistantMessage: "Нашёл простую задачу: MAR-384. Если хочешь, могу её запустить.",
            finish: true,
            toolCalls: [],
            taskMutation: {
              action: "none",
              taskId: "",
              title: "",
              description: "",
              intentType: "general",
              visibility: "hidden",
              projectProfileId: "",
              placeId: "",
              taskType: "general",
              lastUserGoal: "Подобрать простую задачу из Linear"
            },
            executionProposal: {
              kind: "task",
              taskId: "T-00048",
              linearIdentifier: "MAR-384",
              summary: "Простая задача из Linear",
              projectProfileId: "",
              candidateTaskIds: [
                "T-00048"
              ]
            }
          }
        })
    };

    const service = new TelegramChatService({
      store,
      router,
      workerService,
      adapter,
      notifier,
      linear,
      launcherBridge
    });

    const result = await service.handleTelegramEvent({
      chatId: "123",
      messageId: "900",
      username: "vidin",
      text: "подбери простую задачу из linear"
    });

    expect(result.action).toBe("task_suggestions");
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      chatId: "123",
      text: expect.stringContaining("MAR-384")
    }));
    const session = store.getChatSession("telegram", "123");
    expect(session.pendingExecution.taskId).toBe("T-00048");
    expect(session.lastSuggestions[0].taskId).toBe("T-00048");
    expect(store.getLatestChatEvent("telegram", "123").sessionId).toBe(session.id);
  });

  test("starts execution only after natural-language confirmation", async () => {
    const task = store.createTask({
      id: "T-00048",
      source: "linear",
      sourceRef: "MAR-384",
      title: "Simple notification tweak",
      description: "Small change",
      state: "ready_for_execution",
      visibility: "execution",
      executionPendingConfirmation: true
    });
    store.upsertLink(task.id, {
      linkType: "linear_issue",
      externalId: "issue-384",
      meta: {
        identifier: "MAR-384"
      }
    });
    const session = store.ensureChatSession("telegram", "123", {
      pendingExecution: {
        taskId: "T-00048",
        linearIdentifier: "MAR-384",
        summary: "Простая задача",
        candidateTaskIds: ["T-00048"]
      }
    });

    adapter = {
      run: vi.fn()
        .mockResolvedValueOnce({
          raw: {
            responseMode: "execution_started",
            assistantMessage: "",
            finish: false,
            toolCalls: [
              {
                tool: "orchestrator.startExecution",
                argumentsJson: "{\"taskId\":\"T-00048\"}"
              }
            ],
            taskMutation: {
              action: "none",
              taskId: "",
              title: "",
              description: "",
              intentType: "general",
              visibility: "hidden",
              projectProfileId: "",
              placeId: "",
              taskType: "general",
              lastUserGoal: ""
            },
            executionProposal: {
              kind: "none",
              taskId: "",
              linearIdentifier: "",
              summary: "",
              projectProfileId: "",
              candidateTaskIds: []
            }
          }
        })
        .mockResolvedValueOnce({
          raw: {
            responseMode: "execution_started",
            assistantMessage: "Запускаю MAR-384. Если упрёмся в Studio/manual gate, я напишу.",
            finish: true,
            toolCalls: [],
            taskMutation: {
              action: "update",
              taskId: "T-00048",
              title: "",
              description: "",
              intentType: "general",
              visibility: "execution",
              projectProfileId: "",
              placeId: "",
              taskType: "general",
              lastUserGoal: "Запустить первую задачу"
            },
            executionProposal: {
              kind: "none",
              taskId: "",
              linearIdentifier: "",
              summary: "",
              projectProfileId: "",
              candidateTaskIds: []
            }
          }
        })
    };

    const service = new TelegramChatService({
      store,
      router,
      workerService,
      adapter,
      notifier,
      linear,
      launcherBridge
    });

    const result = await service.handleTelegramEvent({
      chatId: "123",
      messageId: "901",
      username: "vidin",
      text: "запускай"
    });

    expect(result.action).toBe("execution_started");
    expect(workerService.runExecution).toHaveBeenCalledWith("T-00048");
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Запускаю MAR-384")
    }));
    const updatedSession = store.getChatSession("telegram", "123");
    expect(updatedSession.pendingExecution).toEqual({});
    expect(store.getTask("T-00048").executionPendingConfirmation).toBe(false);
    expect(session.id).toBe(updatedSession.id);
  });

  test("reports local processing diagnostics for diag command", async () => {
    store.createChatEvent({
      channel: "telegram",
      externalChatId: "123",
      externalMessageId: "800",
      status: "completed",
      action: "task_suggestions",
      taskId: "T-00048",
      userText: "подбери простую задачу",
      meta: {
        durationMs: 1420
      }
    });
    store.createChatEvent({
      channel: "telegram",
      externalChatId: "123",
      externalMessageId: "801",
      status: "failed",
      action: "clarification",
      userText: "что-то ещё",
      errorText: "timeout",
      meta: {
        durationMs: 5100
      }
    });

    adapter = {
      run: vi.fn(async () => {
        throw new Error("diag should not hit codex");
      })
    };

    const service = new TelegramChatService({
      store,
      router,
      workerService,
      adapter,
      notifier,
      linear,
      launcherBridge
    });

    const result = await service.handleTelegramEvent({
      chatId: "123",
      messageId: "999",
      username: "vidin",
      text: "diag"
    });

    expect(result.action).toBe("diag_reported");
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      chatId: "123",
      text: expect.stringContaining("completed")
    }));
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("timeout")
    }));
  });
});
