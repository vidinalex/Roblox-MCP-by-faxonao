import { buildChatPrompt } from "../workers/prompts.mjs";
import { ChatToolRegistry } from "./toolRegistry.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function commandMatch(text) {
  return /^(run|status|cancel|ready|retry)\s+[A-Za-z0-9_-]+$/i.test(text)
    || /^\/?model(?:\s+.+)?$/i.test(text);
}

function isDiagCommand(text) {
  return /^(?:\/?diag|\/?status_here|status here)$/i.test(normalizeText(text));
}

function detectExplicitExecutionIntent(text) {
  return /(run\s+T-\d+|запус|запусти|стартуй|выполняй|сделай|делаем|execute|start it|go ahead)/i.test(normalizeText(text));
}

function detectConfirmationIntent(text) {
  return /^(да|ага|ок|okay|ok|запускай|стартуй|поехали|погнали|делай|готово)$/i.test(normalizeText(text));
}

function toConversationKey(channel, externalId) {
  return `${channel}:${externalId}`;
}

function fallbackTaskMutation() {
  return {
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
  };
}

function fallbackExecutionProposal() {
  return {
    kind: "none",
    taskId: "",
    linearIdentifier: "",
    summary: "",
    projectProfileId: "",
    candidateTaskIds: []
  };
}

function limitToolCalls(calls) {
  if (!Array.isArray(calls)) {
    return [];
  }
  return calls.slice(0, 4).map((entry) => ({
    tool: normalizeText(entry?.tool),
    arguments: parseToolArguments(entry?.argumentsJson)
  })).filter((entry) => entry.tool);
}

function parseToolArguments(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeToolResult(result) {
  return JSON.parse(JSON.stringify(result));
}

function extractSuggestionItems(toolResults) {
  const items = [];
  for (const entry of toolResults) {
    const issues = Array.isArray(entry?.result?.issues) ? entry.result.issues : [];
    for (const issueEntry of issues) {
      items.push({
        taskId: normalizeText(issueEntry?.issue?.localTask?.taskId),
        linearIdentifier: normalizeText(issueEntry?.issue?.identifier),
        title: normalizeText(issueEntry?.issue?.title)
      });
    }
    const tasks = Array.isArray(entry?.result?.tasks) ? entry.result.tasks : [];
    for (const task of tasks) {
      items.push({
        taskId: normalizeText(task?.taskId),
        linearIdentifier: normalizeText(task?.linearIdentifier),
        title: normalizeText(task?.title)
      });
    }
  }
  return items.filter((item) => item.taskId || item.linearIdentifier).slice(0, 5);
}

export class TelegramChatService {
  constructor(options) {
    this.store = options.store;
    this.router = options.router;
    this.workerService = options.workerService;
    this.adapter = options.adapter;
    this.notifier = options.notifier;
    this.linear = options.linear;
    this.launcherBridge = options.launcherBridge;
    this.projectMappings = options.projectMappings || [];
    this.maxToolRounds = options.maxToolRounds || 4;
    this.toolRegistry = new ChatToolRegistry({
      store: this.store,
      linear: this.linear,
      launcherBridge: this.launcherBridge,
      orchestrator: {
        createTask: async (args, context) => await this.createTaskMemory(args, context),
        updateTask: async (args, context) => await this.updateTaskMemory(args, context),
        proposeExecution: async (args, context) => await this.proposeExecution(args, context),
        startExecution: async (args, context) => await this.startExecution(args, context)
      }
    });
  }

  async handleTelegramEvent(event) {
    const text = normalizeText(event.text);
    if (!text) {
      return { ok: true, action: "ignored_empty" };
    }

    if (isDiagCommand(text)) {
      const message = this.buildDiagMessage(event.chatId, event.messageId);
      await this.notifier.send({
        channel: "telegram",
        chatId: String(event.chatId),
        text: message
      });
      return {
        ok: true,
        action: "diag_reported"
      };
    }

    if (commandMatch(text)) {
      return await this.router.handleTelegramEvent(event);
    }

    const session = this.store.ensureChatSession("telegram", event.chatId, {
      conversationKey: toConversationKey("telegram", event.chatId),
      sourceContext: {
        username: event.username || ""
      }
    });
    const chatEvent = this.store.getLatestChatEvent("telegram", event.chatId);
    if (chatEvent && chatEvent.externalMessageId === String(event.messageId) && !chatEvent.sessionId) {
      this.store.updateChatEvent(chatEvent.id, {
        sessionId: session.id
      });
    }

    this.store.appendChatTurn(session.id, "user", text, {
      messageId: event.messageId,
      username: event.username || ""
    });

    const explicitExecutionAllowed = detectExplicitExecutionIntent(text)
      || (Boolean(session.pendingExecution?.taskId || session.pendingExecution?.linearIdentifier) && detectConfirmationIntent(text));
    const toolResults = [];
    let finalPayload = null;

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const freshSession = this.store.getChatSession("telegram", event.chatId) || session;
      const recentTurns = this.store.listChatTurns(freshSession.id, 8);
      const activeTaskHints = this.store.listActiveTasksForChat(event.chatId).slice(0, 5).map((task) => ({
        taskId: task.id,
        title: task.title,
        state: task.state,
        blockedReason: task.blockedReason
      }));
      const prompt = buildChatPrompt({
        session: freshSession,
        pendingExecution: freshSession.pendingExecution,
        recentTurns,
        toolResults,
        userMessage: text,
        explicitExecutionAllowed,
        suggestedTaskIds: (freshSession.lastSuggestions || []).map((entry) => entry.taskId || entry.linearIdentifier).filter(Boolean),
        activeTaskHints,
        projectProfiles: this.store.listProjectProfiles(),
        tools: this.toolRegistry.describeTools()
      });

      const workerResult = await this.adapter.run("chat", {
        workspacePath: process.cwd(),
        userMessage: text,
        prompt
      });
      const payload = this.normalizeWorkerPayload(workerResult.raw);

      if (!payload.finish && payload.toolCalls.length > 0) {
        for (const call of payload.toolCalls) {
          const result = await this.toolRegistry.execute(call.tool, call.arguments, {
            session: freshSession,
            event,
            userMessage: text,
            explicitExecutionAllowed
          });
          toolResults.push({
            tool: call.tool,
            arguments: call.arguments,
            result: summarizeToolResult(result)
          });
        }
        continue;
      }

      finalPayload = payload;
      break;
    }

    if (!finalPayload) {
      finalPayload = {
        responseMode: "clarification",
        assistantMessage: "Не удалось уверенно обработать запрос за один проход. Сформулируй его чуть конкретнее.",
        finish: true,
        toolCalls: [],
        taskMutation: fallbackTaskMutation(),
        executionProposal: fallbackExecutionProposal()
      };
    }

    const appliedTask = await this.applyTaskMutation(finalPayload.taskMutation, {
      session,
      event,
      userMessage: text
    });

    const suggestionItems = extractSuggestionItems(toolResults);
    const nextSession = this.store.updateChatSession(session.id, {
      lastUserGoal: finalPayload.taskMutation.lastUserGoal || text,
      lastAgentAction: finalPayload.responseMode,
      lastTaskId: appliedTask?.id || session.lastTaskId,
      lastSuggestions: suggestionItems.length > 0 ? suggestionItems : session.lastSuggestions
    });

    if (finalPayload.executionProposal.kind !== "none") {
      await this.proposeExecution(finalPayload.executionProposal, {
        session: nextSession,
        event,
        userMessage: text
      });
    } else if (finalPayload.responseMode === "execution_started") {
      this.store.updateChatSession(session.id, {
        pendingExecution: {},
        lastSuggestions: []
      });
    }

    const reply = normalizeText(finalPayload.assistantMessage);
    if (reply) {
      await this.notifier.send({
        channel: "telegram",
        chatId: String(event.chatId),
        text: reply
      });
      this.store.appendChatTurn(session.id, "assistant", reply, {
        responseMode: finalPayload.responseMode
      });
    }

    return {
      ok: true,
      action: finalPayload.responseMode,
      taskId: appliedTask?.id || ""
    };
  }

  buildDiagMessage(chatId, currentMessageId) {
    const recent = this.store.listChatEvents("telegram", String(chatId), 6)
      .filter((entry) => entry.externalMessageId !== String(currentMessageId))
      .slice(0, 5);

    if (recent.length === 0) {
      return "diag: пока нет прошлых событий в этом чате.";
    }

    const lines = recent.map((entry) => {
      const duration = typeof entry.meta?.durationMs === "number" ? `${entry.meta.durationMs}ms` : "-";
      const action = normalizeText(entry.action, "-");
      const taskId = normalizeText(entry.taskId, "-");
      const error = normalizeText(entry.errorText);
      return [
        `- ${entry.status} | action=${action} | task=${taskId} | duration=${duration}`,
        error ? `  error: ${error}` : ""
      ].filter(Boolean).join("\n");
    });

    return [
      "diag:",
      ...lines
    ].join("\n");
  }

  normalizeWorkerPayload(payload) {
    return {
      responseMode: normalizeText(payload?.responseMode, "chat_answer"),
      assistantMessage: normalizeText(payload?.assistantMessage),
      finish: payload?.finish !== false,
      toolCalls: limitToolCalls(payload?.toolCalls),
      taskMutation: payload?.taskMutation && typeof payload.taskMutation === "object"
        ? {
            ...fallbackTaskMutation(),
            ...payload.taskMutation
          }
        : fallbackTaskMutation(),
      executionProposal: payload?.executionProposal && typeof payload.executionProposal === "object"
        ? {
            ...fallbackExecutionProposal(),
            ...payload.executionProposal,
            candidateTaskIds: Array.isArray(payload.executionProposal.candidateTaskIds)
              ? payload.executionProposal.candidateTaskIds.map((entry) => normalizeText(entry)).filter(Boolean)
              : []
          }
        : fallbackExecutionProposal()
    };
  }

  async applyTaskMutation(taskMutation, context) {
    if (!taskMutation || taskMutation.action === "none") {
      return null;
    }
    if (taskMutation.action === "create") {
      const created = this.store.createTask({
        source: "telegram",
        sourceRef: `${context.event.chatId}:${context.event.messageId}`,
        title: taskMutation.title || context.userMessage,
        description: taskMutation.description || context.userMessage,
        projectProfileId: taskMutation.projectProfileId,
        placeId: taskMutation.placeId,
        taskType: taskMutation.taskType || "general",
        state: "new",
        conversationKey: context.session.conversationKey,
        intentType: taskMutation.intentType || "general",
        visibility: taskMutation.visibility || "hidden",
        lastUserGoal: taskMutation.lastUserGoal || context.userMessage,
        sourceContext: {
          chatId: context.event.chatId,
          username: context.event.username || ""
        }
      });
      this.store.upsertLink(created.id, {
        linkType: "telegram_chat",
        externalId: String(context.event.chatId),
        meta: {
          username: context.event.username || ""
        }
      });
      return created;
    }

    if (taskMutation.action === "update" && taskMutation.taskId) {
      return this.store.updateTask(taskMutation.taskId, {
        title: taskMutation.title || undefined,
        description: taskMutation.description || undefined,
        projectProfileId: taskMutation.projectProfileId || undefined,
        placeId: taskMutation.placeId || undefined,
        taskType: taskMutation.taskType || undefined,
        intentType: taskMutation.intentType || undefined,
        visibility: taskMutation.visibility || undefined,
        lastUserGoal: taskMutation.lastUserGoal || undefined
      });
    }

    return null;
  }

  async createTaskMemory(args, context) {
    const task = this.store.createTask({
      source: "telegram",
      sourceRef: `${context.event.chatId}:${context.event.messageId}`,
      title: normalizeText(args.title, context.userMessage),
      description: normalizeText(args.description, context.userMessage),
      projectProfileId: normalizeText(args.projectProfileId),
      placeId: normalizeText(args.placeId),
      taskType: normalizeText(args.taskType, "general"),
      state: "new",
      conversationKey: context.session.conversationKey,
      intentType: normalizeText(args.intentType, "general"),
      visibility: normalizeText(args.visibility, "hidden"),
      lastUserGoal: normalizeText(args.lastUserGoal, context.userMessage),
      sourceContext: {
        chatId: context.event.chatId,
        username: context.event.username || ""
      }
    });
    this.store.upsertLink(task.id, {
      linkType: "telegram_chat",
      externalId: String(context.event.chatId),
      meta: {
        username: context.event.username || ""
      }
    });
    this.store.updateChatSession(context.session.id, {
      lastTaskId: task.id
    });
    return {
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        state: task.state
      }
    };
  }

  async updateTaskMemory(args) {
    const taskId = normalizeText(args.taskId);
    if (!taskId) {
      return { ok: false, error: "taskId is required." };
    }
    const task = this.store.updateTask(taskId, {
      title: args.title,
      description: args.description,
      projectProfileId: args.projectProfileId,
      placeId: args.placeId,
      state: args.state,
      taskType: args.taskType,
      intentType: args.intentType,
      visibility: args.visibility,
      lastUserGoal: args.lastUserGoal,
      lastAgentAction: args.lastAgentAction,
      sourceContext: args.sourceContext
    });
    return {
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        state: task.state
      }
    };
  }

  async importLinearIssue(identifier) {
    const value = normalizeText(identifier);
    if (!value) {
      return null;
    }
    let task = this.store.findTaskByLinearIdentifier(value);
    if (task) {
      return task;
    }
    const issue = await this.linear.getLiveIssue(value);
    if (!issue) {
      return null;
    }
    await this.router.handleLinearEvent(issue);
    task = this.store.findTaskByLinearIdentifier(issue.identifier);
    return task;
  }

  async proposeExecution(args, context) {
    let taskId = normalizeText(args.taskId);
    const candidateTaskIds = Array.isArray(args.candidateTaskIds)
      ? args.candidateTaskIds.map((entry) => normalizeText(entry)).filter(Boolean)
      : [];
    if (!taskId && args.linearIdentifier) {
      const imported = await this.importLinearIssue(args.linearIdentifier);
      taskId = imported?.id || "";
    }

    const resolvedCandidates = [];
    for (const candidate of candidateTaskIds) {
      const task = this.store.getTask(candidate);
      if (task) {
        resolvedCandidates.push(task.id);
      }
    }

    const pending = {
      taskId,
      linearIdentifier: normalizeText(args.linearIdentifier),
      summary: normalizeText(args.summary),
      projectProfileId: normalizeText(args.projectProfileId),
      candidateTaskIds: resolvedCandidates
    };

    this.store.updateChatSession(context.session.id, {
      pendingExecution: pending,
      lastSuggestions: resolvedCandidates.map((candidateId) => {
        const task = this.store.getTask(candidateId);
        return {
          taskId: candidateId,
          linearIdentifier: this.store.listLinks(candidateId, "linear_issue")[0]?.meta?.identifier || "",
          title: task?.title || ""
        };
      })
    });

    if (taskId) {
      this.store.updateTask(taskId, {
        executionPendingConfirmation: true,
        visibility: "execution"
      });
    }

    return {
      ok: true,
      pendingExecution: pending
    };
  }

  async startExecution(args, context) {
    let taskId = normalizeText(args.taskId);
    if (!taskId && context.session.pendingExecution?.taskId) {
      taskId = context.session.pendingExecution.taskId;
    }

    if (!taskId && context.session.pendingExecution?.linearIdentifier) {
      const imported = await this.importLinearIssue(context.session.pendingExecution.linearIdentifier);
      taskId = imported?.id || "";
    }

    if (!taskId) {
      return {
        ok: false,
        error: "No execution target resolved.",
        status: "clarification"
      };
    }

    if (!context.explicitExecutionAllowed) {
      return {
        ok: false,
        error: "Execution requires explicit confirmation.",
        status: "confirmation_required",
        taskId
      };
    }

    let task = this.store.getTask(taskId);
    if (!task) {
      return {
        ok: false,
        error: `Task ${taskId} not found.`,
        status: "failed"
      };
    }

    if (task.state === "new" || task.state === "needs_triage") {
      await this.workerService.runTriage(taskId);
      task = this.store.getTask(taskId);
    }

    if (task.state === "needs_clarification") {
      return {
        ok: false,
        status: "needs_clarification",
        taskId,
        error: task.triageSummary || "Task still needs clarification."
      };
    }

    if (task.state === "blocked_manual") {
      return {
        ok: false,
        status: "blocked_manual",
        taskId,
        error: task.blockedReason || "Task is blocked."
      };
    }

    if (task.state !== "ready_for_execution") {
      return {
        ok: false,
        status: "not_ready",
        taskId,
        error: `Task state is ${task.state}.`
      };
    }

    await this.workerService.runExecution(taskId);
    this.store.updateTask(taskId, {
      executionPendingConfirmation: false
    });
    this.store.updateChatSession(context.session.id, {
      pendingExecution: {},
      lastTaskId: taskId
    });
    task = this.store.getTask(taskId);
    return {
      ok: true,
      status: "started",
      taskId,
      state: task.state
    };
  }
}
