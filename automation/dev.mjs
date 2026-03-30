import { loadAutomationConfig, ensureAutomationRuntimeDirs } from "./shared/config.mjs";
import { runtimeArtifactsDir, runtimeDbPath, runtimeTempDir, launcherProfilesPath } from "./shared/paths.mjs";
import { createLogger } from "./shared/logger.mjs";
import { NotificationHub } from "./shared/notifier.mjs";
import { TaskHubService } from "./task-hub/service.mjs";
import { startTaskHubServer } from "./task-hub/server.mjs";
import { TelegramBotService } from "./telegram-bot/bot.mjs";
import { LinearSyncService } from "./linear-sync/sync.mjs";
import { TelegramChatService } from "./chat/service.mjs";

const logger = createLogger("dev");

async function main() {
  await ensureAutomationRuntimeDirs();
  const config = await loadAutomationConfig();
  const notifier = new NotificationHub();
  const taskHub = new TaskHubService({
    config,
    notifier,
    dbPath: runtimeDbPath,
    tempDir: runtimeTempDir,
    artifactsDir: runtimeArtifactsDir,
    launcherProfilesPath
  });
  await taskHub.bootstrap();

  const linear = new LinearSyncService({
    config: config.linear,
    store: taskHub.store,
    router: taskHub.router
  });
  taskHub.setLinearService(linear);
  const chatService = new TelegramChatService({
    store: taskHub.store,
    router: taskHub.router,
    workerService: taskHub.workerService,
    adapter: taskHub.adapter,
    notifier,
    linear,
    launcherBridge: taskHub.launcherBridge,
    projectMappings: config.projectMappings
  });
  taskHub.setChatService(chatService);
  const telegram = new TelegramBotService({
    config: config.telegram,
    store: taskHub.store,
    router: taskHub.router,
    messageHandler: chatService
  });
  taskHub.router.setLinearTools({
    syncNow: async () => await linear.syncNow(),
    listImportedTasks: (limit = 10) => linear.listImportedTasks(limit)
  });

  notifier.registerTransport(telegram);
  notifier.registerTransport(linear);

  const { server } = await startTaskHubServer(taskHub, config.taskHub);
  logger.info(`Task Hub listening on http://${config.taskHub.host}:${config.taskHub.port}`);

  const background = [
    telegram.start(),
    linear.start()
  ];

  const shutdown = async () => {
    telegram.stop();
    linear.stop();
    await new Promise((resolve) => server.close(resolve));
    taskHub.dispose();
  };

  process.on("SIGINT", async () => {
    logger.info("Shutting down automation runtime.");
    await shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down automation runtime.");
    await shutdown();
    process.exit(0);
  });

  await Promise.all(background);
}

main().catch((error) => {
  logger.error("Automation runtime failed", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
