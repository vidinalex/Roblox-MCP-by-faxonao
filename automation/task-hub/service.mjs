import { TaskHubStore } from "./store.mjs";
import { TaskRouter } from "./router.mjs";
import { AutomationWorkerService } from "../workers/service.mjs";
import { CodexWorkerAdapter } from "../workers/codexAdapter.mjs";
import { LauncherBridge } from "../shared/launcherBridge.mjs";
import { saveAutomationConfig } from "../shared/config.mjs";

export class TaskHubService {
  constructor(options) {
    this.config = options.config;
    this.notifier = options.notifier;
    this.store = options.store || new TaskHubStore({
      dbPath: options.dbPath,
      launcherProfilesPath: options.launcherProfilesPath
    });
    this.launcherBridge = options.launcherBridge || new LauncherBridge({
      controlBaseUrl: this.config.launcher.controlBaseUrl
    });
    this.adapter = options.adapter || new CodexWorkerAdapter({
      config: this.config.codex,
      tempDir: options.tempDir
    });
    this.workerService = new AutomationWorkerService({
      store: this.store,
      adapter: this.adapter,
      launcherBridge: this.launcherBridge,
      artifactsDir: options.artifactsDir,
      projectMappings: this.config.projectMappings,
      notifier: this.notifier
    });
    this.router = new TaskRouter({
      store: this.store,
      workerService: this.workerService,
      projectMappings: this.config.projectMappings,
      notifier: this.notifier,
      getCodexSettings: () => this.getCodexSettings(),
      setCodexSettings: async (patch) => await this.setCodexSettings(patch)
    });
    this.chatService = null;
    this.linearService = null;
  }

  async bootstrap() {
    await this.store.bootstrap();
  }

  dispose() {
    this.store.close();
  }

  listTasks() {
    return this.store.listTasks();
  }

  searchTasks(query, options = {}) {
    return this.store.searchTasks(query, options);
  }

  listBlockedTasks(options = {}) {
    return this.store.listBlockedTasks(options);
  }

  getTaskSnapshot(id) {
    return this.store.getTaskSnapshot(id);
  }

  getLatestChatStatus(chatId) {
    return this.store.getLatestChatEvent("telegram", chatId);
  }

  listChatStatuses(chatId, limit = 20) {
    return this.store.listChatEvents("telegram", chatId, limit);
  }

  listProjectProfiles() {
    return this.store.listProjectProfiles();
  }

  getCodexSettings() {
    return {
      model: this.config.codex.model || "",
      reasoningEffort: this.config.codex.reasoningEffort || ""
    };
  }

  async setCodexSettings(patch) {
    this.config.codex = {
      ...this.config.codex,
      ...patch
    };
    this.config = await saveAutomationConfig(this.config);
    this.adapter.config = this.config.codex;
    return this.getCodexSettings();
  }

  async handleTelegramEvent(event) {
    if (this.chatService) {
      return await this.chatService.handleTelegramEvent(event);
    }
    return await this.router.handleTelegramEvent(event);
  }

  async handleTelegramChatEvent(event) {
    if (!this.chatService) {
      throw new Error("Chat service is not configured.");
    }
    return await this.chatService.handleTelegramEvent(event);
  }

  async handleLinearEvent(issue) {
    return await this.router.handleLinearEvent(issue);
  }

  async handleCommand(taskId, command, context = {}) {
    return await this.router.handleTaskCommand(command, taskId, context);
  }

  async searchLinearIssues(query, options = {}) {
    if (!this.linearService) {
      return [];
    }
    return await this.linearService.searchLiveIssues(query, options);
  }

  async getLinearIssue(identifier) {
    if (!this.linearService) {
      return null;
    }
    return await this.linearService.getLiveIssue(identifier);
  }

  setLinearService(linearService) {
    this.linearService = linearService;
  }

  setChatService(chatService) {
    this.chatService = chatService;
  }

  async proposeExecution(taskId, context = {}) {
    if (!this.chatService) {
      throw new Error("Chat service is not configured.");
    }
    return await this.chatService.proposeExecution({
      taskId,
      summary: context.summary || "",
      projectProfileId: context.projectProfileId || "",
      candidateTaskIds: Array.isArray(context.candidateTaskIds) ? context.candidateTaskIds : []
    }, {
      session: context.session || this.store.ensureChatSession("telegram", context.chatId || "", {}),
      event: {
        chatId: context.chatId || "",
        messageId: context.messageId || "",
        username: context.username || ""
      },
      userMessage: context.userMessage || ""
    });
  }

  async confirmExecution(taskId, context = {}) {
    if (!this.chatService) {
      throw new Error("Chat service is not configured.");
    }
    return await this.chatService.startExecution({
      taskId
    }, {
      session: context.session || this.store.ensureChatSession("telegram", context.chatId || "", {}),
      event: {
        chatId: context.chatId || "",
        messageId: context.messageId || "",
        username: context.username || ""
      },
      userMessage: context.userMessage || "",
      explicitExecutionAllowed: true
    });
  }
}
