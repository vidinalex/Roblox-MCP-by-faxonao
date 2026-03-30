import express from "express";

function wrap(handler) {
  return async (request, response) => {
    try {
      const payload = await handler(request, response);
      if (!response.headersSent) {
        response.json(payload);
      }
    } catch (error) {
      response.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

export function createTaskHubApp(service) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", wrap(async () => ({
    ok: true,
    service: "rbxmcp-automation-task-hub",
    taskCount: service.listTasks().length,
    profileCount: service.listProjectProfiles().length,
    generatedAt: new Date().toISOString()
  })));

  app.get("/profiles", wrap(async () => ({
    ok: true,
    profiles: service.listProjectProfiles()
  })));

  app.get("/tasks", wrap(async () => ({
    ok: true,
    tasks: service.listTasks()
  })));

  app.get("/chat/status/:chatId", wrap(async (request) => ({
    ok: true,
    latest: service.getLatestChatStatus(request.params.chatId),
    recent: service.listChatStatuses(request.params.chatId, Number(request.query.limit) || 10)
  })));

  app.get("/tasks/search", wrap(async (request) => ({
    ok: true,
    tasks: service.searchTasks(request.query.q || "", {
      projectProfileId: request.query.projectProfileId || "",
      source: request.query.source || ""
    })
  })));

  app.get("/tasks/blocked", wrap(async (request) => ({
    ok: true,
    tasks: service.listBlockedTasks({
      projectProfileId: request.query.projectProfileId || ""
    })
  })));

  app.get("/tasks/:id", wrap(async (request) => ({
    ok: true,
    snapshot: service.getTaskSnapshot(request.params.id)
  })));

  app.get("/linear/search", wrap(async (request) => ({
    ok: true,
    issues: await service.searchLinearIssues(request.query.q || "", {
      limit: Number(request.query.limit) || 10
    })
  })));

  app.get("/linear/issues/:identifier", wrap(async (request) => ({
    ok: true,
    issue: await service.getLinearIssue(request.params.identifier)
  })));

  app.post("/events/telegram", wrap(async (request) => ({
    ok: true,
    ...(await service.handleTelegramEvent(request.body || {}))
  })));

  app.post("/chat/telegram-event", wrap(async (request) => ({
    ok: true,
    ...(await service.handleTelegramChatEvent(request.body || {}))
  })));

  app.post("/events/linear", wrap(async (request) => ({
    ok: true,
    ...(await service.handleLinearEvent(request.body || {}))
  })));

  app.post("/tasks/:id/commands", wrap(async (request) => ({
    ok: true,
    ...(await service.handleCommand(request.params.id, request.body?.command, request.body?.context || {}))
  })));

  app.post("/tasks/:id/propose-execution", wrap(async (request) => ({
    ok: true,
    ...(await service.proposeExecution(request.params.id, request.body || {}))
  })));

  app.post("/tasks/:id/confirm-execution", wrap(async (request) => ({
    ok: true,
    ...(await service.confirmExecution(request.params.id, request.body || {}))
  })));

  return app;
}

export async function startTaskHubServer(service, options) {
  const app = createTaskHubApp(service);
  const server = await new Promise((resolve) => {
    const instance = app.listen(options.port, options.host, () => resolve(instance));
  });
  return { app, server };
}
