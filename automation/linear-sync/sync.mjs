import { createLogger } from "../shared/logger.mjs";
import { LinearClient } from "./client.mjs";

function normalizeIssue(node) {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description || "",
    url: node.url || "",
    updatedAt: node.updatedAt,
    teamId: node.team?.id || "",
    teamName: node.team?.name || "",
    projectId: node.project?.id || "",
    projectName: node.project?.name || "",
    stateName: node.state?.name || "",
    labelNames: Array.isArray(node.labels?.nodes) ? node.labels.nodes.map((label) => label.name) : []
  };
}

function matchesFilters(issue, config) {
  if (config.teamIds.length > 0 && !config.teamIds.includes(issue.teamId)) {
    return false;
  }
  if (config.projectIds.length > 0 && !config.projectIds.includes(issue.projectId)) {
    return false;
  }
  if (config.labelNames.length > 0 && !issue.labelNames.some((label) => config.labelNames.includes(label))) {
    return false;
  }
  if (config.stateNames.length > 0 && !config.stateNames.includes(issue.stateName)) {
    return false;
  }
  return true;
}

function matchesQuery(issue, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return issue.identifier.toLowerCase().includes(needle)
    || issue.title.toLowerCase().includes(needle)
    || issue.description.toLowerCase().includes(needle)
    || issue.projectName.toLowerCase().includes(needle)
    || issue.teamName.toLowerCase().includes(needle)
    || issue.labelNames.some((label) => label.toLowerCase().includes(needle));
}

export class LinearNotificationTransport {
  constructor(options) {
    this.client = options.client;
    this.enabled = options.enabled;
  }

  supports(notification) {
    return this.enabled && notification.channel === "linear";
  }

  async send(notification) {
    if (!this.enabled || !notification.issueId) {
      return;
    }
    await this.client.createComment(notification.issueId, notification.text);
  }
}

export class LinearSyncService {
  constructor(options) {
    this.config = options.config;
    this.store = options.store;
    this.router = options.router;
    this.logger = options.logger || createLogger("linear");
    this.client = new LinearClient({
      apiKey: this.config.apiKey
    });
    this.running = false;
  }

  supports(notification) {
    return this.config.enabled && notification.channel === "linear";
  }

  async send(notification) {
    if (!this.config.enabled || !notification.issueId) {
      return;
    }
    await this.client.createComment(notification.issueId, notification.text);
  }

  async syncOnce() {
    if (!this.config.enabled || !this.config.apiKey) {
      return;
    }
    const lastCursor = this.store.getRuntimeMeta("linear.cursor", null);
    const page = await this.client.fetchRecentIssues({
      after: lastCursor?.endCursor || null
    });
    for (const issue of page.nodes.map(normalizeIssue)) {
      if (!matchesFilters(issue, this.config)) {
        continue;
      }
      await this.router.handleLinearEvent(issue);
    }
    this.store.setRuntimeMeta("linear.cursor", page.pageInfo || {});
  }

  async syncNow() {
    await this.syncOnce();
    return this.listImportedTasks();
  }

  listImportedTasks(limit = 10) {
    return this.store.listTasks({ source: "linear" }).slice(0, limit);
  }

  async listLiveIssues(options = {}) {
    if (!this.config.enabled || !this.config.apiKey) {
      return [];
    }
    const page = await this.client.fetchRecentIssueWindow({
      first: options.first || 50,
      pages: options.pages || 2
    });
    return page.nodes
      .map(normalizeIssue)
      .filter((issue) => matchesFilters(issue, this.config))
      .slice(0, options.limit || 20);
  }

  async searchLiveIssues(query, options = {}) {
    const issues = await this.listLiveIssues({
      first: options.first || 50,
      pages: options.pages || 2,
      limit: options.limit || 50
    });
    return issues.filter((issue) => matchesQuery(issue, query)).slice(0, options.limit || 10);
  }

  async getLiveIssue(identifier) {
    const query = String(identifier || "").trim();
    if (!query) {
      return null;
    }
    const issues = await this.searchLiveIssues(query, {
      first: 50,
      pages: 3,
      limit: 50
    });
    const needle = query.toLowerCase();
    return issues.find((issue) => issue.identifier.toLowerCase() === needle || issue.id === query) || issues[0] || null;
  }

  async start() {
    if (!this.config.enabled || !this.config.apiKey) {
      this.logger.info("Linear sync disabled in config.");
      return;
    }
    this.running = true;
    while (this.running) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.logger.warn("Linear sync iteration failed", error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
