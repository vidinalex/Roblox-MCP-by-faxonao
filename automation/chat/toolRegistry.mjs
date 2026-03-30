function normalizeText(value) {
  return String(value ?? "").trim();
}

function summarizeTask(store, task) {
  const linearLink = store.listLinks(task.id, "linear_issue")[0] || null;
  return {
    taskId: task.id,
    source: task.source,
    linearIdentifier: linearLink?.meta?.identifier || "",
    title: task.title,
    state: task.state,
    taskType: task.taskType,
    projectProfileId: task.projectProfileId,
    requiresStudio: task.requiresStudio,
    requiresManualVerification: task.requiresManualVerification,
    blockedReason: task.blockedReason,
    triageSummary: task.triageSummary,
    executionSummary: task.executionSummary,
    visibility: task.visibility
  };
}

function summarizeIssue(issue, localTask = null) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    teamName: issue.teamName,
    projectName: issue.projectName,
    stateName: issue.stateName,
    labelNames: issue.labelNames,
    localTask: localTask ? {
      taskId: localTask.id,
      state: localTask.state,
      requiresStudio: localTask.requiresStudio,
      blockedReason: localTask.blockedReason
    } : null
  };
}

function scoreIssue(issue, localTask) {
  let score = 100;
  const reasons = [];
  const descriptionLength = normalizeText(issue.description).length;
  const titleLength = normalizeText(issue.title).length;

  if (!localTask) {
    score += 12;
    reasons.push("no_local_blockers");
  } else {
    if (["blocked_manual", "executing"].includes(localTask.state)) {
      score -= 60;
      reasons.push("already_blocked_or_running");
    }
    if (["done", "cancelled", "failed"].includes(localTask.state)) {
      score -= 80;
      reasons.push("not_a_fresh_candidate");
    }
    if (localTask.requiresStudio) {
      score -= 15;
      reasons.push("needs_studio");
    }
    if (localTask.requiresManualVerification) {
      score -= 10;
      reasons.push("needs_manual_verification");
    }
  }

  if (descriptionLength === 0) {
    score += 6;
    reasons.push("short_description");
  } else if (descriptionLength < 220) {
    score += 10;
    reasons.push("compact_scope");
  } else if (descriptionLength > 600) {
    score -= 10;
    reasons.push("long_description");
  }

  if (titleLength < 80) {
    score += 5;
    reasons.push("compact_title");
  }

  if (/\b(ui|notif|notification|label|button|text|bug|small|minor)\b/i.test(`${issue.title} ${issue.description}`)) {
    score += 6;
    reasons.push("looks_small");
  }

  return {
    score,
    reasons
  };
}

function compact(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ChatToolRegistry {
  constructor(options) {
    this.store = options.store;
    this.linear = options.linear;
    this.launcherBridge = options.launcherBridge;
    this.orchestrator = options.orchestrator;
  }

  describeTools() {
    return [
      { name: "taskhub.listTasks", safety: "safe", description: "List local tasks from task-hub.", argumentsShape: { limit: "number", state: "string", source: "string", projectProfileId: "string" } },
      { name: "taskhub.getTask", safety: "safe", description: "Get one local task with status and links.", argumentsShape: { taskId: "string" } },
      { name: "taskhub.searchTasks", safety: "safe", description: "Search local task-hub tasks by text.", argumentsShape: { query: "string", limit: "number", projectProfileId: "string", source: "string" } },
      { name: "taskhub.listBlockedTasks", safety: "safe", description: "List blocked local tasks.", argumentsShape: { limit: "number", projectProfileId: "string" } },
      { name: "taskhub.listByProject", safety: "safe", description: "List local tasks for a project profile.", argumentsShape: { projectProfileId: "string", limit: "number" } },
      { name: "linear.listIssues", safety: "safe", description: "List live Linear issues under configured filters.", argumentsShape: { limit: "number", ranking: "recent|simple" } },
      { name: "linear.searchIssues", safety: "safe", description: "Search live Linear issues by text.", argumentsShape: { query: "string", limit: "number", ranking: "recent|simple" } },
      { name: "linear.getIssue", safety: "safe", description: "Get one live Linear issue by identifier.", argumentsShape: { identifier: "string" } },
      { name: "launcher.listProfiles", safety: "safe", description: "List launcher project profiles.", argumentsShape: {} },
      { name: "launcher.getProfileStatus", safety: "safe", description: "Get profile plus MCP health if available.", argumentsShape: { profileId: "string", port: "string" } },
      { name: "launcher.ensureProfile", safety: "safe", description: "Start or adopt a launcher profile.", argumentsShape: { profileId: "string" } },
      { name: "mcp.getHealth", safety: "safe", description: "Read MCP health for a profile or port.", argumentsShape: { profileId: "string", port: "string" } },
      { name: "orchestrator.createTask", safety: "safe", description: "Create hidden or normal local task memory.", argumentsShape: { title: "string", description: "string", projectProfileId: "string", placeId: "string", taskType: "string", intentType: "string", visibility: "hidden|normal|execution", lastUserGoal: "string" } },
      { name: "orchestrator.updateTask", safety: "safe", description: "Update local task memory.", argumentsShape: { taskId: "string", title: "string", description: "string", projectProfileId: "string", placeId: "string", state: "string", lastUserGoal: "string" } },
      { name: "orchestrator.proposeExecution", safety: "safe", description: "Store a pending execution proposal for later confirmation.", argumentsShape: { taskId: "string", linearIdentifier: "string", summary: "string", projectProfileId: "string", candidateTaskIds: ["string"] } },
      { name: "orchestrator.startExecution", safety: "mutating", description: "Start real execution for a local task after explicit confirmation.", argumentsShape: { taskId: "string" } }
    ];
  }

  async execute(tool, args = {}, context = {}) {
    switch (tool) {
      case "taskhub.listTasks":
        return this.listTasks(args);
      case "taskhub.getTask":
        return this.getTask(args);
      case "taskhub.searchTasks":
        return this.searchTasks(args);
      case "taskhub.listBlockedTasks":
        return this.listBlockedTasks(args);
      case "taskhub.listByProject":
        return this.listByProject(args);
      case "linear.listIssues":
        return await this.listIssues(args);
      case "linear.searchIssues":
        return await this.searchIssues(args);
      case "linear.getIssue":
        return await this.getIssue(args);
      case "launcher.listProfiles":
        return await this.listProfiles();
      case "launcher.getProfileStatus":
        return await this.getProfileStatus(args);
      case "launcher.ensureProfile":
        return await this.ensureProfile(args);
      case "mcp.getHealth":
        return await this.getMcpHealth(args);
      case "orchestrator.createTask":
        return await this.orchestrator.createTask(args, context);
      case "orchestrator.updateTask":
        return await this.orchestrator.updateTask(args, context);
      case "orchestrator.proposeExecution":
        return await this.orchestrator.proposeExecution(args, context);
      case "orchestrator.startExecution":
        return await this.orchestrator.startExecution(args, context);
      default:
        throw new Error(`Unsupported chat tool ${tool}`);
    }
  }

  listTasks(args = {}) {
    return {
      tasks: this.store.listTasks({
        state: normalizeText(args.state),
        source: normalizeText(args.source),
        projectProfileId: normalizeText(args.projectProfileId)
      }).slice(0, Number(args.limit) || 10).map((task) => summarizeTask(this.store, task))
    };
  }

  getTask(args = {}) {
    const taskId = normalizeText(args.taskId);
    const snapshot = this.store.getTaskSnapshot(taskId);
    if (!snapshot) {
      return { task: null };
    }
    return {
      task: summarizeTask(this.store, snapshot.task),
      links: snapshot.links,
      openQuestions: snapshot.questions.filter((question) => question.status === "open"),
      recentRuns: snapshot.runs.slice(0, 3)
    };
  }

  searchTasks(args = {}) {
    const results = this.store.searchTasks(normalizeText(args.query), {
      source: normalizeText(args.source),
      projectProfileId: normalizeText(args.projectProfileId)
    });
    return {
      tasks: results.slice(0, Number(args.limit) || 10).map((task) => summarizeTask(this.store, task))
    };
  }

  listBlockedTasks(args = {}) {
    return {
      tasks: this.store.listBlockedTasks({
        projectProfileId: normalizeText(args.projectProfileId)
      }).slice(0, Number(args.limit) || 10).map((task) => summarizeTask(this.store, task))
    };
  }

  listByProject(args = {}) {
    return {
      tasks: this.store.listTasks({
        projectProfileId: normalizeText(args.projectProfileId)
      }).slice(0, Number(args.limit) || 10).map((task) => summarizeTask(this.store, task))
    };
  }

  async listIssues(args = {}) {
    const issues = await this.linear.listLiveIssues({
      limit: Number(args.limit) || 10
    });
    return this.rankIssues(issues, normalizeText(args.ranking, "recent"));
  }

  async searchIssues(args = {}) {
    const issues = await this.linear.searchLiveIssues(normalizeText(args.query), {
      limit: Number(args.limit) || 10
    });
    return this.rankIssues(issues, normalizeText(args.ranking, "simple"));
  }

  async getIssue(args = {}) {
    const issue = await this.linear.getLiveIssue(normalizeText(args.identifier));
    if (!issue) {
      return { issue: null };
    }
    const localTask = this.store.findTaskByLinearIdentifier(issue.identifier);
    return {
      issue: summarizeIssue(issue, localTask),
      score: scoreIssue(issue, localTask)
    };
  }

  rankIssues(issues, ranking) {
    const enriched = issues.map((issue) => {
      const localTask = this.store.findTaskByLinearIdentifier(issue.identifier);
      return {
        issue: summarizeIssue(issue, localTask),
        score: scoreIssue(issue, localTask)
      };
    });

    const ordered = ranking === "simple"
      ? enriched.sort((left, right) => right.score.score - left.score.score)
      : enriched;

    return compact({
      issues: ordered
    });
  }

  async listProfiles() {
    const profiles = await this.launcherBridge.listProfiles();
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        port: profile.port,
        expectedPlaceId: profile.expectedPlaceId
      }))
    };
  }

  resolveProfile(args = {}) {
    const profileId = normalizeText(args.profileId);
    const port = normalizeText(args.port);
    if (profileId) {
      return this.store.getProjectProfile(profileId);
    }
    if (port) {
      return this.store.findProjectProfileByPort(port);
    }
    return null;
  }

  async getProfileStatus(args = {}) {
    const profile = this.resolveProfile(args);
    if (!profile) {
      return { profile: null };
    }
    let health = null;
    let error = "";
    try {
      health = await this.launcherBridge.getMcpHealth(profile.port);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    return {
      profile,
      health,
      error
    };
  }

  async ensureProfile(args = {}) {
    const profile = this.resolveProfile(args);
    if (!profile) {
      return { ok: false, error: "Profile not found." };
    }
    try {
      const response = await this.launcherBridge.ensureProfile(profile.id);
      return { ok: true, profile, response };
    } catch (failure) {
      return {
        ok: false,
        profile,
        error: failure instanceof Error ? failure.message : String(failure)
      };
    }
  }

  async getMcpHealth(args = {}) {
    const profile = this.resolveProfile(args);
    const port = profile?.port || normalizeText(args.port);
    if (!port) {
      return { ok: false, error: "Port not provided." };
    }
    try {
      return {
        ok: true,
        profile,
        health: await this.launcherBridge.getMcpHealth(port)
      };
    } catch (failure) {
      return {
        ok: false,
        profile,
        error: failure instanceof Error ? failure.message : String(failure)
      };
    }
  }
}
