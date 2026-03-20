import express from "express";
import { launcherControlHost, launcherControlPort } from "./constants.mjs";

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

export function createLauncherControlApp(service) {
  const app = express();
  app.use(express.json({ limit: "512kb" }));

  app.get("/launcher/health", wrap(async () => ({
    ok: true,
    service: "rbxmcp-launcher",
    controlPort: launcherControlPort,
    host: launcherControlHost
  })));

  app.get("/launcher/profiles", wrap(async () => ({
    ok: true,
    profiles: await service.listProfiles()
  })));

  app.post("/launcher/profiles", wrap(async (request) => ({
    ok: true,
    profile: await service.createProfile(request.body || {})
  })));

  app.patch("/launcher/profiles/:id", wrap(async (request) => ({
    ok: true,
    profile: await service.updateProfile(request.params.id, request.body || {})
  })));

  app.delete("/launcher/profiles/:id", wrap(async (request) => {
    await service.deleteProfile(request.params.id);
    return { ok: true };
  }));

  app.post("/launcher/profiles/:id/start", wrap(async (request) => ({
    ok: true,
    runtime: await service.startProfile(request.params.id)
  })));

  app.post("/launcher/profiles/:id/stop", wrap(async (request) => ({
    ok: true,
    result: await service.stopProfile(request.params.id, request.body || {})
  })));

  app.post("/launcher/profiles/:id/restart", wrap(async (request) => ({
    ok: true,
    runtime: await service.restartProfile(request.params.id)
  })));

  app.post("/launcher/resolve-by-port", wrap(async (request) => ({
    ok: true,
    ...(await service.resolveByPort(request.body?.port))
  })));

  return app;
}

export async function startLauncherControlApi(service, options = {}) {
  const app = createLauncherControlApp(service);
  const host = options.host || launcherControlHost;
  const port = options.port || launcherControlPort;
  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });
  return { app, server, host, port };
}
