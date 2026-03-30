function normalizeText(value) {
  return String(value ?? "").trim();
}

function pickTitle(text) {
  const line = normalizeText(text).split(/\r?\n/)[0] || "Untitled task";
  return line.slice(0, 120);
}

function parseTaskCommand(text) {
  const match = normalizeText(text).match(/^(run|status|cancel|ready|retry)\s+([A-Za-z0-9_-]+)$/i);
  if (!match) {
    return null;
  }
  return {
    name: match[1].toLowerCase(),
    taskId: match[2]
  };
}

function parseTaskReference(text) {
  const match = normalizeText(text).match(/^(T-\d{5})$/i);
  if (!match) {
    return null;
  }
  return {
    taskId: match[1].toUpperCase()
  };
}

function parseModelCommand(text) {
  const match = normalizeText(text).match(/^\/?model(?:\s+([^\s]+))?(?:\s+([^\s]+))?$/i);
  if (!match) {
    return null;
  }
  return {
    model: normalizeText(match[1]),
    reasoningEffort: normalizeText(match[2])
  };
}

const CYRILLIC_LINEAR = "\u043B\u0430\u0439\u043D\u0438\u0440";

function stripLinearTrigger(text) {
  const escaped = CYRILLIC_LINEAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b(linear|${escaped})\\b`, "gi"), "").trim();
}

function parseLinearIntent(text) {
  const raw = normalizeText(text);
  const lowered = raw.toLowerCase();
  if (!lowered.includes("linear") && !lowered.includes(CYRILLIC_LINEAR)) {
    return null;
  }

  const escaped = CYRILLIC_LINEAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicit = raw.match(new RegExp(`^/?(?:linear|${escaped})(?:\\s+(sync|list|find|open))?(?:\\s+(.+))?$`, "i"));
  if (explicit) {
    return {
      action: (explicit[1] || "list").toLowerCase(),
      query: normalizeText(explicit[2])
    };
  }

  const hasFindIntent = /(find|search|\u043D\u0430\u0439\u0434|\u043F\u043E\u0438\u0449|\u043F\u0440\u043E\u0441\u0442)/i.test(raw);
  if (hasFindIntent) {
    return {
      action: "find",
      query: stripLinearTrigger(raw)
    };
  }

  return {
    action: "list",
    query: ""
  };
}

function findProjectMapping(mappings, predicate) {
  return mappings.find(predicate) || null;
}

export class TaskRouter {
  constructor(options) {
    this.store = options.store;
    this.workerService = options.workerService;
    this.projectMappings = options.projectMappings || [];
    this.notifier = options.notifier;
    this.getCodexSettings = options.getCodexSettings || (() => ({ model: "", reasoningEffort: "" }));
    this.setCodexSettings = options.setCodexSettings || (async () => this.getCodexSettings());
    this.linearTools = options.linearTools || {
      syncNow: async () => [],
      listImportedTasks: () => []
    };
  }

  setLinearTools(linearTools) {
    this.linearTools = {
      ...this.linearTools,
      ...linearTools
    };
  }

  mapTelegramProject(chatId) {
    return findProjectMapping(this.projectMappings, (mapping) => mapping.telegramChatId && mapping.telegramChatId === String(chatId));
  }

  mapLinearProject(issue) {
    return findProjectMapping(this.projectMappings, (mapping) => {
      if (mapping.linearProjectId && issue.projectId && mapping.linearProjectId === issue.projectId) {
        return true;
      }
      if (mapping.linearTeamId && issue.teamId && mapping.linearTeamId === issue.teamId) {
        return true;
      }
      if (mapping.linearLabel && Array.isArray(issue.labelNames) && issue.labelNames.includes(mapping.linearLabel)) {
        return true;
      }
      return false;
    });
  }

  async handleModelCommand(text, context = {}) {
    const command = parseModelCommand(text);
    if (!command) {
      return null;
    }

    if (!command.model) {
      const current = this.getCodexSettings();
      await this.notifier.send({
        channel: context.source === "telegram" ? "telegram" : "linear",
        chatId: context.chatId,
        issueId: context.issueId,
        text: [
          "Current Codex model settings:",
          `model: ${current.model || "(default)"}`,
          `reasoning: ${current.reasoningEffort || "(default)"}`
        ].join("\n")
      });
      return { ok: true, action: "model_reported" };
    }

    const next = await this.setCodexSettings({
      model: command.model,
      reasoningEffort: command.reasoningEffort || this.getCodexSettings().reasoningEffort || ""
    });

    await this.notifier.send({
      channel: context.source === "telegram" ? "telegram" : "linear",
      chatId: context.chatId,
      issueId: context.issueId,
      text: [
        "Codex model updated.",
        `model: ${next.model || "(default)"}`,
        `reasoning: ${next.reasoningEffort || "(default)"}`
      ].join("\n")
    });

    return { ok: true, action: "model_updated", settings: next };
  }

  describeLinearTask(task) {
    const link = this.store.listLinks(task.id, "linear_issue")[0] || null;
    const identifier = link?.meta?.identifier || link?.externalId || task.sourceRef || task.id;
    const url = link?.externalUrl || "";
    return {
      taskId: task.id,
      identifier,
      title: task.title,
      state: task.state,
      url
    };
  }

  findLinearTasks(query, limit = 5) {
    const needle = normalizeText(query).toLowerCase();
    const tasks = this.linearTools.listImportedTasks ? this.linearTools.listImportedTasks(50) : this.store.listTasks({ source: "linear" });
    const filtered = !needle
      ? tasks
      : tasks.filter((task) => {
        const link = this.store.listLinks(task.id, "linear_issue")[0] || null;
        const identifier = String(link?.meta?.identifier || task.sourceRef || "").toLowerCase();
        return task.title.toLowerCase().includes(needle)
          || task.description.toLowerCase().includes(needle)
          || identifier.includes(needle);
      });
    return filtered.slice(0, limit).map((task) => this.describeLinearTask(task));
  }

  async handleLinearIntent(text, context = {}) {
    const intent = parseLinearIntent(text);
    if (!intent) {
      return null;
    }

    if (!this.linearTools?.syncNow) {
      await this.notifier.send({
        channel: context.source === "telegram" ? "telegram" : "linear",
        chatId: context.chatId,
        issueId: context.issueId,
        text: "Linear integration is not available in this runtime."
      });
      return { ok: true, action: "linear_unavailable" };
    }

    if (intent.action === "sync") {
      const tasks = await this.linearTools.syncNow();
      const lines = tasks.slice(0, 5).map((task) => {
        const entry = this.describeLinearTask(task);
        return `- ${entry.identifier}: ${entry.title} -> ${entry.taskId}`;
      });
      await this.notifier.send({
        channel: context.source === "telegram" ? "telegram" : "linear",
        chatId: context.chatId,
        issueId: context.issueId,
        text: [
          "Linear sync complete.",
          `Imported tasks: ${tasks.length}`,
          lines.length > 0 ? "" : "No matching issues found in current filters.",
          ...lines
        ].filter(Boolean).join("\n")
      });
      return { ok: true, action: "linear_sync" };
    }

    if (intent.action === "open") {
      await this.linearTools.syncNow();
      const match = this.findLinearTasks(intent.query, 1)[0];
      const textBody = match
        ? [
            `${match.identifier}: ${match.title}`,
            `Task: ${match.taskId}`,
            match.url ? `URL: ${match.url}` : ""
          ].filter(Boolean).join("\n")
        : `No Linear issue matched "${intent.query}".`;
      await this.notifier.send({
        channel: context.source === "telegram" ? "telegram" : "linear",
        chatId: context.chatId,
        issueId: context.issueId,
        text: textBody
      });
      return { ok: true, action: "linear_open" };
    }

    await this.linearTools.syncNow();
    const results = this.findLinearTasks(intent.action === "find" ? intent.query : "", 5);
    const header = intent.action === "find"
      ? `Linear matches for "${intent.query || "current filters"}":`
      : "Recent Linear tasks:";
    await this.notifier.send({
      channel: context.source === "telegram" ? "telegram" : "linear",
      chatId: context.chatId,
      issueId: context.issueId,
      text: [
        header,
        ...(results.length > 0
          ? results.map((entry) => `- ${entry.identifier}: ${entry.title} -> ${entry.taskId}`)
          : ["No matching issues found."])
      ].join("\n")
    });
    return { ok: true, action: "linear_list" };
  }

  async handleTelegramEvent(event) {
    const text = normalizeText(event.text);

    const modelResult = await this.handleModelCommand(text, {
      source: "telegram",
      chatId: event.chatId
    });
    if (modelResult) {
      return modelResult;
    }

    const linearResult = await this.handleLinearIntent(text, {
      source: "telegram",
      chatId: event.chatId
    });
    if (linearResult) {
      return linearResult;
    }

    const command = parseTaskCommand(text);
    if (command) {
      return await this.handleTaskCommand(command.name, command.taskId, {
        source: "telegram",
        chatId: event.chatId
      });
    }

    const reference = parseTaskReference(text);
    if (reference) {
      return await this.handleTaskCommand("status", reference.taskId, {
        source: "telegram",
        chatId: event.chatId
      });
    }

    let task = event.taskId ? this.store.getTask(event.taskId) : null;
    if (!task) {
      const active = this.store.listActiveTasksForChat(event.chatId);
      if (active.length === 1 && (active[0].state === "needs_clarification" || active[0].state === "blocked_manual")) {
        task = active[0];
      }
    }

    if (task && task.state === "needs_clarification") {
      this.store.appendMessage(task.id, {
        source: "telegram",
        direction: "inbound",
        messageType: "clarification",
        body: text,
        meta: event
      });
      this.store.answerNextOpenQuestion(task.id, text);
      this.store.updateTask(task.id, {
        state: "needs_triage",
        lastOperatorMessageAt: new Date().toISOString()
      });
      await this.workerService.runTriage(task.id);
      return { ok: true, taskId: task.id, action: "clarification_recorded" };
    }

    if (task && task.state === "blocked_manual" && /^ready$/i.test(text)) {
      return await this.handleTaskCommand("ready", task.id, {
        source: "telegram",
        chatId: event.chatId
      });
    }

    const mapping = this.mapTelegramProject(event.chatId);
    const created = this.store.createTask({
      source: "telegram",
      sourceRef: `${event.chatId}:${event.messageId}`,
      title: pickTitle(text),
      description: text,
      projectProfileId: mapping?.launcherProfileId || "",
      placeId: mapping?.expectedPlaceId || "",
      taskType: "general",
      state: "needs_triage",
      requiresStudio: Boolean(mapping?.launcherProfileId)
    });

    this.store.upsertLink(created.id, {
      linkType: "telegram_chat",
      externalId: String(event.chatId),
      meta: {
        username: event.username || ""
      }
    });

    this.store.appendMessage(created.id, {
      source: "telegram",
      direction: "inbound",
      messageType: "task_request",
      body: text,
      meta: event
    });

    await this.notifier.send({
      channel: "telegram",
      chatId: String(event.chatId),
      taskId: created.id,
      text: `Task ${created.id} accepted. Starting triage.`
    });

    await this.workerService.runTriage(created.id);
    return { ok: true, taskId: created.id, action: "created" };
  }

  async handleLinearEvent(issue) {
    let task = this.store.findTaskByLink("linear_issue", issue.id);
    const mapping = this.mapLinearProject(issue);

    if (!task) {
      task = this.store.createTask({
        source: "linear",
        sourceRef: issue.identifier || issue.id,
        title: issue.title,
        description: issue.description || issue.title,
        projectProfileId: mapping?.launcherProfileId || "",
        placeId: mapping?.expectedPlaceId || "",
        taskType: "general",
        state: "needs_triage",
        requiresStudio: Boolean(mapping?.launcherProfileId)
      });

      this.store.upsertLink(task.id, {
        linkType: "linear_issue",
        externalId: issue.id,
        externalUrl: issue.url || "",
        meta: {
          identifier: issue.identifier || "",
          teamId: issue.teamId || "",
          projectId: issue.projectId || ""
        }
      });

      if (mapping?.telegramChatId) {
        this.store.upsertLink(task.id, {
          linkType: "telegram_chat",
          externalId: mapping.telegramChatId
        });
      }

      await this.workerService.runTriage(task.id);
      return { ok: true, taskId: task.id, action: "created_from_linear" };
    }

    this.store.updateTask(task.id, {
      title: issue.title || task.title,
      description: issue.description || task.description,
      projectProfileId: mapping?.launcherProfileId || task.projectProfileId,
      placeId: mapping?.expectedPlaceId || task.placeId
    });

    this.store.appendMessage(task.id, {
      source: "linear",
      direction: "inbound",
      messageType: "sync",
      body: issue.description || issue.title,
      meta: issue
    });

    return { ok: true, taskId: task.id, action: "updated_from_linear" };
  }

  async handleTaskCommand(name, taskId, context = {}) {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    if (name === "status") {
      await this.notifier.send({
        channel: context.source === "telegram" ? "telegram" : "linear",
        chatId: context.chatId,
        issueId: context.issueId,
        taskId,
        text: [
          `Task ${task.id}`,
          `State: ${task.state}`,
          task.triageSummary ? `Triage: ${task.triageSummary}` : "",
          task.executionSummary ? `Execution: ${task.executionSummary}` : "",
          task.blockedReason ? `Blocked: ${task.blockedReason}` : ""
        ].filter(Boolean).join("\n")
      });
      return { ok: true, taskId, action: "status_reported" };
    }

    if (name === "cancel") {
      this.store.updateTask(taskId, {
        state: "cancelled",
        blockedReason: "Cancelled by operator."
      });
      return { ok: true, taskId, action: "cancelled" };
    }

    if (name === "retry") {
      const latestRun = this.store.listRuns(taskId)[0];
      if (latestRun?.mode === "execute") {
        await this.workerService.runExecution(taskId);
        return { ok: true, taskId, action: "execution_retried" };
      }
      await this.workerService.runTriage(taskId);
      return { ok: true, taskId, action: "triage_retried" };
    }

    if (name === "ready") {
      if (task.state === "blocked_manual" || task.state === "ready_for_execution") {
        await this.workerService.runExecution(taskId);
        return { ok: true, taskId, action: "execution_started" };
      }
      return { ok: true, taskId, action: "ignored" };
    }

    if (name === "run") {
      if (task.state !== "ready_for_execution") {
        throw new Error(`Task ${task.id} is not ready for execution. Current state: ${task.state}.`);
      }
      await this.workerService.runExecution(taskId);
      return { ok: true, taskId, action: "execution_started" };
    }

    throw new Error(`Unsupported command ${name}.`);
  }
}
