import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request, { SuperTest, Test } from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService, BridgeServiceOptions } from "../src/bridge/bridgeService.js";
import { createBridgeHttpApp } from "../src/bridge/httpApi.js";
import { CacheStore } from "../src/cache/cacheStore.js";
import { sourceHash } from "../src/lib/hash.js";

interface TestContext {
  tempDir: string;
}

interface StudioCommand {
  commandId: string;
  type: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
}

const contexts: TestContext[] = [];

async function createContext(options: BridgeServiceOptions = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "rbxmcp-"));
  contexts.push({ tempDir });
  const cache = new CacheStore(tempDir);
  const bridge = new BridgeService(cache, options);
  await bridge.bootstrap();
  const app = createBridgeHttpApp(bridge);
  return { api: request(app), bridge };
}

async function hello(api: SuperTest<Test>): Promise<string> {
  const response = await api.post("/v1/studio/hello").send({
    clientId: "plugin-1",
    placeId: "place-123",
    placeName: "Arena",
    pluginVersion: "0.1.8",
    editorApiAvailable: true,
    base64Transport: true,
    playApiAvailable: true,
    logCaptureAvailable: true
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
  return response.body.sessionId as string;
}

async function pollOne(api: SuperTest<Test>, sessionId: string, waitMs = 1000): Promise<StudioCommand> {
  const poll = await api.post("/v1/studio/poll").send({ sessionId, waitMs });
  expect(poll.status).toBe(200);
  expect(Array.isArray(poll.body.commands)).toBe(true);
  expect(poll.body.commands.length).toBeGreaterThan(0);
  return poll.body.commands[0] as StudioCommand;
}

async function pushPartial(
  api: SuperTest<Test>,
  sessionId: string,
  path: string[],
  source: string,
  mode: "all" | "partial" = "partial"
): Promise<void> {
  const response = await api.post("/v1/studio/push_snapshot").send({
    sessionId,
    mode,
    scripts: [{ path, class: "Script", source, readChannel: "editor", draftAware: true }]
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

async function pushSnapshot(
  api: SuperTest<Test>,
  sessionId: string,
  mode: "all" | "partial",
  scripts: Array<{ path: string[]; class: "Script" | "LocalScript" | "ModuleScript"; source: string }>
): Promise<void> {
  const response = await api.post("/v1/studio/push_snapshot").send({
    sessionId,
    mode,
    scripts: scripts.map((script) => ({
      ...script,
      readChannel: "editor",
      draftAware: true
    }))
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

async function pushUiRoots(
  api: SuperTest<Test>,
  sessionId: string,
  roots: unknown[],
  mode: "all" | "partial" = "partial"
): Promise<void> {
  const response = await api.post("/v1/studio/push_ui_snapshot").send({
    sessionId,
    mode,
    roots
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

async function seedScripts(
  api: SuperTest<Test>,
  bridge: BridgeService,
  sessionId: string,
  scripts: Array<{ path: string[]; class: "Script" | "LocalScript" | "ModuleScript"; source: string }>
): Promise<void> {
  const listPromise = bridge.listScripts();
  const snapshotAll = await pollOne(api, sessionId);
  expect(snapshotAll.type).toBe("snapshot_all_scripts");
  await pushSnapshot(api, sessionId, "all", scripts);
  await complete(api, sessionId, snapshotAll.commandId, { count: scripts.length });
  await listPromise;
}

async function complete(
  api: SuperTest<Test>,
  sessionId: string,
  commandId: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const response = await api.post("/v1/studio/result").send({
    sessionId,
    commandId,
    ok: true,
    result: payload
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

async function completeError(
  api: SuperTest<Test>,
  sessionId: string,
  commandId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const response = await api.post("/v1/studio/result").send({
    sessionId,
    commandId,
    ok: false,
    error: {
      code,
      message,
      details
    }
  });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
}

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) {
      await rm(ctx.tempDir, { recursive: true, force: true });
    }
  }
});

describe("bridge integration", () => {
  it("supports snapshot and hash-locked update flow with draft metadata", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    let studioSource = "print('old')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_all_scripts");
    expect(snapshotAll.timeoutMs).toBe(90_000);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });

    const listed = await listPromise;
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toEqual(path);
    expect(listed[0].draftAware).toBe(true);
    expect(listed[0].readChannel).toBe("editor");

    const expectedHash = sourceHash(studioSource);
    const updatePromise = bridge.updateScript(path, "print('new')", expectedHash);

    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    expect(writeCommand.timeoutMs).toBe(45_000);
    const writePayload = writeCommand.payload as { expectedHash: string; newSource: string };
    expect(writePayload.expectedHash).toBe(expectedHash);
    expect((writeCommand.payload as { newSourceBase64?: string }).newSourceBase64).toBe(
      Buffer.from("print('new')", "utf8").toString("base64")
    );
    studioSource = writePayload.newSource;
    await complete(api, sessionId, writeCommand.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });

    const updated = await updatePromise;
    expect(updated.source).toBe("print('new')");
    expect(updated.hash).toBe(sourceHash("print('new')"));
    expect(updated.draftAware).toBe(true);
    expect(updated.readChannel).toBe("editor");

    const health = bridge.health();
    const draft = health.draft as Record<string, unknown>;
    const commandTimeoutsMs = health.commandTimeoutsMs as Record<string, unknown>;
    expect(draft.writeMode).toBe("draft_only");
    expect(draft.editorApiAvailable).toBe(true);
    expect(draft.lastReadChannel).toBe("editor");
    expect(draft.lastWriteChannel).toBe("editor");
    expect(commandTimeoutsMs.snapshotAllScripts).toBe(90_000);
    expect(commandTimeoutsMs.snapshotScriptByPath).toBe(30_000);
    expect(commandTimeoutsMs.setScriptSourceIfHash).toBe(45_000);
    expect(commandTimeoutsMs.upsertScript).toBe(45_000);
    expect(commandTimeoutsMs.default).toBe(15_000);
  });

  it("returns hash_conflict when expected hash is stale", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    const studioSource = "print('current')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const updatePromise = bridge.updateScript(path, "print('new')", sourceHash("print('stale')"));
    const updateError = updatePromise.then(
      () => null,
      (error: Error) => error
    );
    const write = await pollOne(api, sessionId);
    expect(write.type).toBe("set_script_source_if_hash");
    await completeError(api, sessionId, write.commandId, "hash_conflict", "Hash mismatch in Studio", {
      expectedHash: sourceHash("print('stale')"),
      currentHash: sourceHash(studioSource)
    });

    expect((await updateError)?.message).toMatch(/Hash mismatch in Studio/);

    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.status).toBe(200);
    expect(pollAfter.body.commands).toHaveLength(0);
  });

  it("handles 43->999 manual change and then updates to 1014 with fresh hash", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    let studioSource = "warn(43)";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    // Manual Studio edit outside MCP.
    studioSource = "warn(999)";

    const staleUpdate = bridge.updateScript(path, "warn(1014)", sourceHash("warn(43)"));
    const staleError = staleUpdate.then(
      () => null,
      (error: Error) => error
    );
    const writeForConflict = await pollOne(api, sessionId);
    expect(writeForConflict.type).toBe("set_script_source_if_hash");
    await completeError(api, sessionId, writeForConflict.commandId, "hash_conflict", "Hash mismatch in Studio", {
      expectedHash: sourceHash("warn(43)"),
      currentHash: sourceHash(studioSource)
    });
    expect((await staleError)?.message).toMatch(/Hash mismatch in Studio/);

    const freshUpdate = bridge.updateScript(path, "warn(1014)", sourceHash("warn(999)"));
    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    studioSource = "warn(1014)";
    await complete(api, sessionId, writeCommand.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });

    const updated = await freshUpdate;
    expect(updated.source).toBe("warn(1014)");
    expect(updated.hash).toBe(sourceHash("warn(1014)"));
  });

  it("propagates draft_unavailable write error without fallback", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    const studioSource = "print('old')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const updatePromise = bridge.updateScript(path, "print('new')", sourceHash(studioSource));
    const updateError = updatePromise.then(
      () => null,
      (error: Error) => error
    );
    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    const writeResult = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: writeCommand.commandId,
      ok: false,
      error: {
        code: "draft_unavailable",
        message: "No editor draft document"
      }
    });
    expect(writeResult.status).toBe(200);
    expect(writeResult.body.ok).toBe(true);

    expect((await updateError)?.message).toMatch(/No editor draft document/);

    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.status).toBe(200);
    expect(pollAfter.body.commands).toHaveLength(0);
  });

  it("propagates plugin_internal_error immediately without waiting for timeout", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    const studioSource = "print('old')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const updatePromise = bridge.updateScript(path, "print('new')", sourceHash(studioSource));
    const updateError = updatePromise.then(
      () => null,
      (error: Error) => error
    );
    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    expect(writeCommand.timeoutMs).toBe(45_000);
    const writeResult = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: writeCommand.commandId,
      ok: false,
      error: {
        code: "plugin_internal_error",
        message: "unexpected nil dereference"
      }
    });
    expect(writeResult.status).toBe(200);
    expect(writeResult.body.ok).toBe(true);
    expect((await updateError)?.message).toMatch(/unexpected nil dereference/);
  });

  it("verifies multiline update readback before reporting success", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    let studioSource = "local value = 1\nreturn value\n";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const nextSource = "local value = 2\nreturn value\n";
    const updatePromise = bridge.updateScript(path, nextSource, sourceHash(studioSource));

    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    studioSource = nextSource;
    await complete(api, sessionId, writeCommand.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });

    const verifyRefresh = await pollOne(api, sessionId);
    expect(verifyRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, studioSource);
    await complete(api, sessionId, verifyRefresh.commandId);

    const updated = await updatePromise;
    expect(updated.source).toBe(studioSource);
    expect(updated.hash).toBe(sourceHash(studioSource));
  });

  it("returns write_verification_failed when multiline readback differs after update", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    const studioSource = "local value = 1\nreturn value\n";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const nextSource = "local value = 2\nreturn value\n";
    const updatePromise = bridge.updateScript(path, nextSource, sourceHash(studioSource));
    const updateError = updatePromise.then(
      () => null,
      (error: Error) => error as Error & { code?: string; details?: Record<string, unknown> }
    );

    const writeCommand = await pollOne(api, sessionId);
    expect(writeCommand.type).toBe("set_script_source_if_hash");
    await complete(api, sessionId, writeCommand.commandId, {
      path,
      hash: sourceHash(nextSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });

    const verifyRefresh = await pollOne(api, sessionId);
    expect(verifyRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, "local value = 2 return value ");
    await complete(api, sessionId, verifyRefresh.commandId);

    const error = await updateError;
    expect(error?.message).toMatch(/Written script content differed after save/);
    expect(error?.code).toBe("write_verification_failed");
  });

  it("handles multiple sequential updates of the same script", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    let studioSource = "print('v1')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    const listed = await listPromise;
    expect(listed[0].hash).toBe(sourceHash(studioSource));

    const update1 = bridge.updateScript(path, "print('v2')", sourceHash(studioSource));
    const write1 = await pollOne(api, sessionId);
    expect(write1.timeoutMs).toBe(45_000);
    studioSource = (write1.payload as { newSource: string }).newSource;
    await complete(api, sessionId, write1.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });
    const done1 = await update1;
    expect(done1.hash).toBe(sourceHash("print('v2')"));

    const update2 = bridge.updateScript(path, "print('v3')", done1.hash);
    const write2 = await pollOne(api, sessionId);
    expect(write2.timeoutMs).toBe(45_000);
    studioSource = (write2.payload as { newSource: string }).newSource;
    await complete(api, sessionId, write2.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });
    const done2 = await update2;
    expect(done2.hash).toBe(sourceHash("print('v3')"));
    expect(done2.source).toBe("print('v3')");
  });

  it("exposes agent capabilities for empty-chat bootstrap", async () => {
    const { api } = await createContext({ projectAlias: "Arena-A", bridgePort: 5025 });
    const response = await api.get("/v1/agent/capabilities");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectAlias).toBe("Arena-A");
    expect(response.body.mode).toBe("one_port_one_project_one_session");
    expect(response.body.bridge.port).toBe(5025);
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_script");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_project_summary");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_related_context");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_ui_summary");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/explain_error");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/validate_operation");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/apply_script_patch");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/diff_script");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/delete_script");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/move_script");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/find_entrypoints");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/find_remotes");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/find_ui_bindings");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/rank_files_by_relevance");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_changed_since");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_symbol_context");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/search_text");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/get_ui_layout_snapshot");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/validate_ui_layout");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/apply_ui_batch");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/clone_ui_subtree");
    expect(response.body.operations.agentHttp).toContain("POST /v1/agent/apply_ui_template");
    expect(response.body.contract.schemaUrl).toBe("/v1/agent/schema");
    expect(response.body.contract.modelWaitPolicy.maxSyncWaitMs).toBe(30_000);
    expect(response.body.contract.aliases.recommendedMaxSyncWaitMs).toBe("30000");
    expect(response.body.contract.contracts.update_script.aliases.pathType).toBe("string");
    expect(response.body.contract.contracts.update_script.aliases.recommendedMaxSyncWaitMs).toBe("30000");
    expect(response.body.contract.contracts.apply_script_patch.aliases.patchType).toBe("array<op>");
    expect(response.body.contract.contracts.create_script.gotchas).toContain("Do not wait longer than 30 seconds for heavy operations; use requestId with get_request_trace if still pending.");
    expect(response.body.contract.contracts.get_related_context.gotchas).toContain("target must be an object.");
    expect(response.body.contracts.findEntrypoints.optional).toEqual(["query", "service", "limit", "verbosity"]);
    expect(response.body.contracts.findRemotes.optional).toEqual(["query", "limit", "verbosity"]);
    expect(response.body.contracts.rankFilesByRelevance.required).toEqual(["query"]);
    expect(response.body.contracts.getChangedSince.required).toEqual(["cursorOrTimestamp"]);
    expect(response.body.contracts.getChangedSince.optional).toEqual(["limit"]);
    expect(response.body.contracts.getSymbolContext.required).toEqual(["symbol"]);
    expect(response.body.contracts.applyUiBatch.required).toEqual(["rootPath", "expectedVersion", "operations"]);
    expect(response.body.preferredBootstrapParams.verbosity).toBe("minimal");
    expect(response.body.ui.layoutDiagnosticsSupported).toBe("edit_time_only");
    expect(response.body.bindings.mode).toBe("heuristic");
    expect(response.body.remoteGraph.mode).toBe("static_heuristic_v2");
    expect(response.body.contracts.cloneUiSubtree.required).toEqual([
      "rootPath",
      "sourcePath",
      "newParentPath",
      "expectedVersion"
    ]);
    expect(response.body.contracts.applyUiTemplate.required).toEqual([
      "kind",
      "rootPath",
      "targetPath",
      "expectedVersion",
      "options"
    ]);
    expect(response.body.ui.createPolicy).toBe("strict_ui_only");
    expect(response.body.ui.preferredMutationMode).toBe("batch");
    expect(response.body.preferredBootstrapCalls).toEqual([
      "GET /v1/agent/capabilities",
      "GET /v1/agent/schema",
      "POST /v1/agent/health",
      "POST /v1/agent/get_project_summary"
    ]);
    expect(response.body.bootstrapWorkflow[0]).toMatch(/get_project_summary/);
    expect(response.body.recommendedNextStepByError.hash_conflict).toMatch(/get_script/);
    expect(response.body.recommendedWorkflows.projectNavigation[0]).toMatch(/find_entrypoints/);
    expect(response.body.recommendedWorkflows.symbolDebug[0]).toMatch(/get_symbol_context/);
    expect(response.body.recommendedWorkflows.scriptPatchReview[0]).toMatch(/apply_script_patch/);
    expect(response.body.recommendedWorkflows.uiClone[0]).toMatch(/clone_ui_subtree/);
    expect(response.body.recommendedWorkflows.uiTemplate[0]).toMatch(/apply_ui_template/);
  });

  it("exposes detailed response schemas for agent endpoints", async () => {
    const { api } = await createContext();
    const response = await api.get("/v1/agent/schema");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    const getScript = response.body.endpoints.find((endpoint: { id: string }) => endpoint.id === "get_script");
    const updateScriptMetadata = response.body.endpoints.find((endpoint: { id: string }) => endpoint.id === "update_script_metadata");
    const updateUiMetadata = response.body.endpoints.find((endpoint: { id: string }) => endpoint.id === "update_ui_metadata");
    expect(getScript?.responseSchema?.anyOf).toHaveLength(2);
    expect(getScript.responseSchema.anyOf[0].properties.source.type).toBe("string");
    expect(getScript.responseSchema.anyOf[0].properties.tags.items.type).toBe("string");
    expect(updateScriptMetadata?.responseSchema?.anyOf).toHaveLength(2);
    expect(updateScriptMetadata.responseSchema.anyOf[0].properties.attributes.type).toBe("object");
    expect(updateScriptMetadata.responseSchema.anyOf[0].required).toEqual(expect.arrayContaining(["path", "hash", "tags", "attributes"]));
    expect(updateUiMetadata?.responseSchema?.anyOf).toHaveLength(2);
    expect(updateUiMetadata.responseSchema.anyOf[0].properties.node.$ref).toBeTruthy();
    expect(updateUiMetadata.responseSchema.$defs.__schema0.properties.children.type).toBe("array");
  });

  it("supports bootstrap summary and explain_error over agent facade", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const scriptPath = ["ServerScriptService", "BootstrapScript"];
    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, scriptPath, "print('boot')", "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const summary = await api.post("/v1/agent/get_project_summary").send({ scope: "scripts" });
    expect(summary.status).toBe(200);
    expect(summary.body.ok).toBe(true);
    expect(summary.body.scripts.totalScripts).toBe(1);
    expect(summary.body.recommendedNextCalls).toContain("rbx_get_related_context");

    const explained = await api.post("/v1/agent/explain_error").send({ code: "hash_conflict" });
    expect(explained.status).toBe(200);
    expect(explained.body.ok).toBe(true);
    expect(explained.body.retryable).toBe(true);
    expect(explained.body.recommendedNextCall.endpoint).toBe("/v1/agent/get_script");
  });

  it("bootstraps empty cache via get_project_summary", async () => {
    const { api } = await createContext();
    const sessionId = await hello(api);

    const summaryPromise = api.post("/v1/agent/get_project_summary").send({ scope: "all" }).then((response) => response);

    const scriptsSnapshot = await pollOne(api, sessionId);
    expect(scriptsSnapshot.type).toBe("snapshot_all_scripts");
    await pushSnapshot(api, sessionId, "all", [
      { path: ["ServerScriptService", "Bootstrap"], class: "Script", source: "print('boot')" }
    ]);
    await complete(api, sessionId, scriptsSnapshot.commandId, { count: 1 });

    const uiSnapshot = await pollOne(api, sessionId);
    expect(uiSnapshot.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [
      {
        path: ["StarterGui", "MainGui"],
        service: "StarterGui",
        name: "MainGui",
        className: "ScreenGui",
        version: "ui-root-v1",
        updatedAt: new Date().toISOString(),
        props: {},
        unsupportedProperties: [],
        children: []
      }
    ], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });

    const summary = await summaryPromise;
    expect(summary.status).toBe(200);
    expect(summary.body.ok).toBe(true);
    expect(summary.body.scripts.totalScripts).toBe(1);
    expect(summary.body.ui.rootCount).toBe(1);
  });

  it("supports agent related_context for symbol lookups", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    await seedScripts(api, bridge, sessionId, [
      {
        path: ["ReplicatedStorage", "Util", "Greeter"],
        class: "ModuleScript",
        source: "local M = {}\nfunction M.hello() return 'hi' end\nreturn M\n"
      },
      {
        path: ["ServerScriptService", "Main"],
        class: "Script",
        source: "local G = require(game.ReplicatedStorage.Util.Greeter)\nprint(G.hello())\n"
      }
    ]);

    const response = await api.post("/v1/agent/get_related_context").send({
      target: { symbol: "hello" },
      budgetTokens: 1000
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.target.kind).toBe("symbol");
    expect(response.body.chunks.length).toBeGreaterThan(0);
    expect(response.body.relatedScripts.length).toBeGreaterThan(0);
  });

  it("supports graph and relevance retrieval endpoints over agent facade", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    await seedScripts(api, bridge, sessionId, [
      {
        path: ["ServerScriptService", "Bootstrap.server"],
        class: "Script",
        source: [
          "local Players = game:GetService('Players')",
          "local BuyRemote = game.ReplicatedStorage.Remotes.BuyItem",
          "Players.PlayerAdded:Connect(function() end)",
          "BuyRemote.OnServerEvent:Connect(function(player, itemId)",
          "    print(itemId)",
          "end)"
        ].join("\n")
      },
      {
        path: ["StarterGui", "MainGui", "Shop.client"],
        class: "LocalScript",
        source: [
          "local BuyRemote = game.ReplicatedStorage.Remotes:WaitForChild('BuyItem')",
          "script.Parent.ShopButton.Activated:Connect(function()",
          "    BuyRemote:FireServer('Sword')",
          "end)"
        ].join("\n")
      },
      {
        path: ["ReplicatedStorage", "Shared", "RemoteNames"],
        class: "ModuleScript",
        source: "local M = {}\nfunction M.getBuyRemoteName() return 'BuyItem' end\nreturn M\n"
      }
    ]);

    const uiWarm = bridge.listUiRoots();
    const uiSnapshot = await pollOne(api, sessionId);
    expect(uiSnapshot.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [
      {
        path: ["StarterGui", "MainGui"],
        service: "StarterGui",
        name: "MainGui",
        className: "ScreenGui",
        version: "ui-root-v1",
        updatedAt: new Date().toISOString(),
        props: {},
        unsupportedProperties: [],
        children: [
          {
            path: ["StarterGui", "MainGui", "ShopButton"],
            service: "StarterGui",
            name: "ShopButton",
            className: "TextButton",
            version: "ui-button-v1",
            updatedAt: new Date().toISOString(),
            props: { Text: "Buy Item" },
            unsupportedProperties: [],
            children: []
          }
        ]
      }
    ], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });
    await uiWarm;

    const entrypoints = await api.post("/v1/agent/find_entrypoints").send({ service: "ServerScriptService" });
    expect(entrypoints.status).toBe(200);
    expect(
      entrypoints.body.entrypoints.some(
        (item: { path: string; category: string }) =>
          item.path === "ServerScriptService/Bootstrap.server" &&
          (item.category === "server_bootstrap" || item.category === "remote_handler")
      )
    ).toBe(true);

    const remotes = await api.post("/v1/agent/find_remotes").send({ query: "BuyRemote" });
    expect(remotes.status).toBe(200);
    expect(remotes.body.remotes.length).toBeGreaterThan(0);
    expect(remotes.body.remotes[0].emitters.length).toBeGreaterThan(0);
    expect(remotes.body.remotes[0].handlers.length).toBeGreaterThan(0);

    const ranked = await api.post("/v1/agent/rank_files_by_relevance").send({ query: "BuyRemote", limit: 5 });
    expect(ranked.status).toBe(200);
    expect(ranked.body.items.length).toBeGreaterThan(0);
    expect(ranked.body.items[0].why.length).toBeGreaterThan(0);

    const symbolContext = await api.post("/v1/agent/get_symbol_context").send({ symbol: "getBuyRemoteName", budgetTokens: 800 });
    expect(symbolContext.status).toBe(200);
    expect(symbolContext.body.definition).toBeTruthy();
    expect(symbolContext.body.chunks.length).toBeGreaterThan(0);

    const journal = await api.post("/v1/agent/get_changed_since").send({ cursorOrTimestamp: "0" });
    expect(journal.status).toBe(200);
    expect(journal.body.items.some((item: { kind: string }) => item.kind === "script")).toBe(true);
    expect(journal.body.items.some((item: { kind: string }) => item.kind === "ui_root")).toBe(true);
    expect(journal.body.nextCursor).toBeTruthy();
  });

  it("supports agent search_text and returns cache transparency", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["Workspace", "Script"];
    const studioSource = "warn (68)";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const response = await api.post("/v1/agent/search_text").send({ query: "warn (68)" });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.count).toBeGreaterThan(0);
    expect(response.body.cacheUpdatedAt).toBeTruthy();
  });

  it("returns structured 404 hint for unknown endpoints", async () => {
    const { api } = await createContext();
    const response = await api.post("/v1/agent/does_not_exist").send({});
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("endpoint_not_found");
    expect(response.body.error.details.hint).toMatch(/capabilities/);
  });

  it("refreshes before read when maxAgeMs is exceeded", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "WarnScript"];
    let studioSource = "warn(43)";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    studioSource = "warn(999)";
    const getPromise = api
      .post("/v1/agent/get_script")
      .send({ path: "ServerScriptService/WarnScript", maxAgeMs: 0 })
      .then((response) => response);
    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, studioSource);
    await complete(api, sessionId, refresh.commandId);
    const response = await getPromise;

    expect(response.status).toBe(200);
    expect(response.body.source).toBe("warn(999)");
    expect(response.body.fromCache).toBe(false);
    expect(response.body.refreshedBeforeRead).toBe(true);
  });

  it("returns already_exists for create_script on existing path", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["StarterGui", "ExistingScript"];
    const studioSource = "print('exists')";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    await pushPartial(api, sessionId, path, studioSource, "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const createPromise = api
      .post("/v1/agent/create_script")
      .send({
        path: "StarterGui/ExistingScript",
        className: "LocalScript",
        source: "print('new')"
      })
      .then((response) => response);
    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, studioSource);
    await complete(api, sessionId, refresh.commandId);
    const createResponse = await createPromise;

    expect(createResponse.status).toBe(409);
    expect(createResponse.body.error.code).toBe("already_exists");
    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.body.commands).toHaveLength(0);
  });

  it("creates missing script without post-write refresh for large payload flows", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ReplicatedStorage", "Utils", "GeneratedModule"];
    const source = "return " + JSON.stringify({ payload: "x".repeat(70_000) });

    const createPromise = api
      .post("/v1/agent/create_script")
      .send({
        path: "ReplicatedStorage/Utils/GeneratedModule",
        className: "ModuleScript",
        source
      })
      .then((response) => response);

    const preRefresh = await pollOne(api, sessionId);
    expect(preRefresh.type).toBe("snapshot_script_by_path");
    await completeError(api, sessionId, preRefresh.commandId, "not_found", "Script not found", { path });

    const upsert = await pollOne(api, sessionId);
    expect(upsert.type).toBe("upsert_script");
    await complete(api, sessionId, upsert.commandId, {
      path,
      className: "ModuleScript",
      hash: sourceHash(source),
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });

    const response = await createPromise;
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.hash).toBe(sourceHash(source));
    expect(response.body.requestId).toBeTruthy();
    expect(response.body.path).toBe("ReplicatedStorage/Utils/GeneratedModule");
    expect(response.body.source).toBeUndefined();
    expect(response.body.sourceOmitted).toBe(true);
    expect(response.body.size).toBe(Buffer.byteLength(source, "utf8"));

    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.body.commands).toHaveLength(0);

    const stored = await bridge.getScript(path);
    expect(stored.source).toBe(source);
    expect(stored.hash).toBe(sourceHash(source));
    expect(stored.readChannel).toBe("editor");
  }, 10_000);

  it("rejects hello when RBXMCP_EXPECT_PLACE_ID mismatches", async () => {
    const { api } = await createContext({ expectedPlaceId: "expected-place" });
    const response = await api.post("/v1/studio/hello").send({
      clientId: "plugin-1",
      placeId: "another-place",
      placeName: "Arena",
      pluginVersion: "0.1.8"
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("project_mismatch");
  });

  it("rejects mutating update when explicit placeId mismatches active project", async () => {
    const { api } = await createContext();
    const sessionId = await hello(api);
    const response = await api.post("/v1/agent/update_script").send({
      path: "ServerScriptService/MainScript",
      newSource: "print('x')",
      expectedHash: "abc",
      placeId: "other-place"
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("project_mismatch");
    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.body.commands).toHaveLength(0);
  });

  it("gates admin upsert by feature flag", async () => {
    const disabled = await createContext();
    const denied = await disabled.api.post("/v1/admin/upsert_script").send({
      path: ["StarterGui", "AdminDenied"],
      className: "LocalScript",
      source: "print('x')"
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("admin_mutations_disabled");

    const enabled = await createContext({ adminMutationsEnabled: true });
    const sessionId = await hello(enabled.api);
    const path = ["StarterGui", "AdminAllowed"];
    const source = "print('allowed')";
    const upsertPromise = enabled.api
      .post("/v1/admin/upsert_script")
      .send({
        path,
        className: "LocalScript",
        source
      })
      .then((response) => response);
    const upsertCommand = await pollOne(enabled.api, sessionId);
    expect(upsertCommand.type).toBe("upsert_script");
    await complete(enabled.api, sessionId, upsertCommand.commandId, {
      path,
      className: "LocalScript",
      hash: sourceHash(source),
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });
    const allowed = await upsertPromise;
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
  });

  it("uses sourceBase64 as source of truth for unicode snapshots", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ReplicatedStorage", "UnicodeModule"];
    const unicodeSource = "return 'привет'";

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_all_scripts");
    const push = await api.post("/v1/studio/push_snapshot").send({
      sessionId,
      mode: "all",
      scripts: [
        {
          path,
          class: "ModuleScript",
          source: "return '??????'",
          sourceBase64: Buffer.from(unicodeSource, "utf8").toString("base64"),
          readChannel: "editor",
          draftAware: true
        }
      ]
    });
    expect(push.status).toBe(200);
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const script = await bridge.getScript(path);
    expect(script.source).toBe(unicodeSource);
  });

  it("propagates plugin hash from snapshot into get/update hash contract", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["Workspace", "Script"];

    const listPromise = bridge.listScripts();
    const snapshotAll = await pollOne(api, sessionId);
    const push = await api.post("/v1/studio/push_snapshot").send({
      sessionId,
      mode: "all",
      scripts: [
        {
          path,
          class: "Script",
          source: "warn (68)",
          hash: "43fd0b24",
          readChannel: "editor",
          draftAware: true
        }
      ]
    });
    expect(push.status).toBe(200);
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await listPromise;

    const script = await bridge.getScript(path);
    expect(script.hash).toBe("43fd0b24");
  });

  it("supports ui list/get/search/update flow", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: { IgnoreGuiInset: false },
      unsupportedProperties: [],
      children: [
        {
          path: ["StarterGui", "MainGui", "TitleLabel"],
          service: "StarterGui",
          name: "TitleLabel",
          className: "TextLabel",
          version: "ui-title-v1",
          updatedAt: new Date().toISOString(),
          props: { Text: "Hello world" },
          unsupportedProperties: [],
          children: []
        }
      ]
    };

    const listPromise = bridge.listUiRoots();
    const uiSnapshot = await pollOne(api, sessionId);
    expect(uiSnapshot.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });
    const roots = await listPromise;
    expect(roots).toHaveLength(1);

    const tree = await bridge.getUiTree(["StarterGui", "MainGui", "TitleLabel"], 0, { forceRefresh: false });
    expect(tree.props.Text).toBe("Hello world");

    const hits = await bridge.searchUi("hello");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toEqual(["StarterGui", "MainGui", "TitleLabel"]);

    const updatePromise = bridge.updateUi(["StarterGui", "MainGui", "TitleLabel"], "ui-title-v1", { Text: "Updated title" });
    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: "ui-title-v1" });

    const mutate = await pollOne(api, sessionId);
    expect(mutate.type).toBe("mutate_ui_batch_if_version");
    await complete(api, sessionId, mutate.commandId, { ok: true });

    const refreshedRoot = {
      ...root,
      version: "ui-root-v2",
      children: [
        {
          ...root.children[0],
          version: "ui-title-v2",
          props: { Text: "Updated title" }
        }
      ]
    };
    const refreshAfter = await pollOne(api, sessionId);
    expect(refreshAfter.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [refreshedRoot], "partial");
    await complete(api, sessionId, refreshAfter.commandId, { version: "ui-title-v2" });

    const updated = await updatePromise;
    expect(updated.version).toBe("ui-title-v2");
    expect(updated.props.Text).toBe("Updated title");
  });

  it("supports agent get_ui_summary with refresh semantics", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: [
        {
          path: ["StarterGui", "MainGui", "ShopButton"],
          service: "StarterGui",
          name: "ShopButton",
          className: "TextButton",
          version: "ui-btn-v1",
          updatedAt: new Date().toISOString(),
          props: { Text: "Open Shop" },
          unsupportedProperties: [],
          children: []
        }
      ]
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const response = await api.post("/v1/agent/get_ui_summary").send({
      path: "StarterGui/MainGui",
      forceRefresh: false
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.nodeCount).toBeGreaterThan(0);
    expect(response.body.classHistogram.some((item: { label: string }) => item.label === "TextButton")).toBe(true);
    expect(response.body.textNodes.length).toBeGreaterThan(0);
  });

  it("returns path_blocked_by_non_ui_child for blocked UI subtree refresh", async () => {
    const { api } = await createContext();
    const sessionId = await hello(api);
    const path = ["ReplicatedFirst", "Screens", "TimeRewardsScreen", "Templates"];

    const responsePromise = api
      .post("/v1/agent/get_ui_tree")
      .send({ path: "ReplicatedFirst/Screens/TimeRewardsScreen/Templates", forceRefresh: true })
      .then((response) => response);

    const warm = await pollOne(api, sessionId);
    expect(warm.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [], "all");
    await complete(api, sessionId, warm.commandId, { count: 0 });

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    const result = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: refresh.commandId,
      ok: false,
      error: {
        code: "path_blocked_by_non_ui_child",
        message: "UI path is blocked by a non-UI child",
        details: {
          path,
          blockedPath: path,
          blockedClassName: "Folder"
        }
      }
    });
    expect(result.status).toBe(200);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("path_blocked_by_non_ui_child");
    expect(response.body.error.details.blockedClassName).toBe("Folder");
  });

  it("rejects non-UI classes in create_ui", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: []
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const responsePromise = api
      .post("/v1/agent/create_ui")
      .send({
        parentPath: "StarterGui/MainGui",
        className: "Folder",
        name: "Templates"
      })
      .then((response) => response);

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const mutate = await pollOne(api, sessionId);
    expect(mutate.type).toBe("mutate_ui_batch_if_version");
    const mutateResult = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: mutate.commandId,
      ok: false,
      error: {
        code: "ui_class_not_supported",
        message: "Only UI-relevant classes are supported by the UI API",
        details: {
          operationIndex: 1,
          className: "Folder"
        }
      }
    });
    expect(mutateResult.status).toBe(200);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ui_class_not_supported");
  });

  it("returns name_occupied_by_non_ui_child instead of already_exists for hidden non-UI conflicts", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["ReplicatedFirst", "Screens", "TimeRewardsScreen"],
      service: "ReplicatedFirst",
      name: "TimeRewardsScreen",
      className: "ScreenGui",
      version: "ui-screen-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: [
        {
          path: ["ReplicatedFirst", "Screens", "TimeRewardsScreen", "Root"],
          service: "ReplicatedFirst",
          name: "Root",
          className: "Frame",
          version: "ui-root-frame-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: []
        }
      ]
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const responsePromise = api
      .post("/v1/agent/create_ui")
      .send({
        parentPath: "ReplicatedFirst/Screens/TimeRewardsScreen",
        className: "Frame",
        name: "Templates"
      })
      .then((response) => response);

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const mutate = await pollOne(api, sessionId);
    const mutateResult = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: mutate.commandId,
      ok: false,
      error: {
        code: "name_occupied_by_non_ui_child",
        message: "Name is occupied by a non-UI child",
        details: {
          operationIndex: 1,
          path: ["ReplicatedFirst", "Screens", "TimeRewardsScreen"],
          name: "Templates",
          blockingClassName: "Folder"
        }
      }
    });
    expect(mutateResult.status).toBe(200);

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("name_occupied_by_non_ui_child");
    expect(response.body.error.details.blockingClassName).toBe("Folder");
  });

  it("applies one batch of UI mutations under a single version lock", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: { IgnoreGuiInset: false },
      unsupportedProperties: [],
      children: []
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const responsePromise = api
      .post("/v1/agent/apply_ui_batch")
      .send({
        rootPath: "StarterGui/MainGui",
        expectedVersion: "ui-root-v1",
        operations: [
          {
            op: "create_node",
            parentPath: "StarterGui/MainGui",
            className: "Frame",
            name: "Templates"
          },
          {
            op: "update_props",
            path: "StarterGui/MainGui",
            props: { IgnoreGuiInset: true }
          }
        ]
      })
      .then((response) => response);

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const mutate = await pollOne(api, sessionId);
    expect(mutate.type).toBe("mutate_ui_batch_if_version");
    expect((mutate.payload as { rootPath: string[] }).rootPath).toEqual(["StarterGui", "MainGui"]);
    expect(((mutate.payload as { operations: unknown[] }).operations || [])).toHaveLength(2);
    await complete(api, sessionId, mutate.commandId, { ok: true });

    const refreshedRoot = {
      ...root,
      version: "ui-root-v2",
      props: { IgnoreGuiInset: true },
      children: [
        {
          path: ["StarterGui", "MainGui", "Templates"],
          service: "StarterGui",
          name: "Templates",
          className: "Frame",
          version: "ui-templates-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: []
        }
      ]
    };
    const refreshAfter = await pollOne(api, sessionId);
    expect(refreshAfter.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [refreshedRoot], "partial");
    await complete(api, sessionId, refreshAfter.commandId, { version: refreshedRoot.version });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body.appliedCount).toBe(2);
    expect(response.body.version).toBe("ui-root-v2");
    expect(response.body.root.children[0].name).toBe("Templates");
  });

  it("returns version_conflict for stale apply_ui_batch without partial mutation", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: []
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const responsePromise = api
      .post("/v1/agent/apply_ui_batch")
      .send({
        rootPath: "StarterGui/MainGui",
        expectedVersion: "stale-version",
        operations: [
          {
            op: "create_node",
            parentPath: "StarterGui/MainGui",
            className: "Frame",
            name: "Templates"
          }
        ]
      })
      .then((response) => response);

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("version_conflict");

    const pollAfter = await api.post("/v1/studio/poll").send({ sessionId, waitMs: 100 });
    expect(pollAfter.status).toBe(200);
    expect(pollAfter.body.commands).toHaveLength(0);
  });

  it("validates script_patch, applies it, and returns review diff hunks", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "PatchTarget"];
    let studioSource = ["local value = 1", "print(value)"].join("\n");

    await seedScripts(api, bridge, sessionId, [{ path, class: "Script", source: studioSource }]);
    const originalHash = sourceHash(studioSource);

    const validate = await api.post("/v1/agent/validate_operation").send({
      kind: "script_patch",
      payload: {
        path: "ServerScriptService/PatchTarget",
        expectedHash: originalHash,
        patch: [{ op: "replace_text", oldText: "value = 1", newText: "value = 2" }]
      }
    });
    expect(validate.status).toBe(200);
    expect(validate.body.valid).toBe(true);

    const applyPromise = api
      .post("/v1/agent/apply_script_patch")
      .send({
        path: "ServerScriptService/PatchTarget",
        expectedHash: originalHash,
        patch: [{ op: "replace_text", oldText: "value = 1", newText: "value = 2" }]
      })
      .then((response) => response);

    const refreshBefore = await pollOne(api, sessionId);
    expect(refreshBefore.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, studioSource);
    await complete(api, sessionId, refreshBefore.commandId);

    const write = await pollOne(api, sessionId);
    expect(write.type).toBe("set_script_source_if_hash");
    studioSource = ((write.payload as { newSource: string }).newSource);
    expect(studioSource).toContain("value = 2");
    await complete(api, sessionId, write.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });
    const verifyRefresh = await pollOne(api, sessionId);
    expect(verifyRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, path, studioSource);
    await complete(api, sessionId, verifyRefresh.commandId);

    const applyResponse = await applyPromise;
    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body.operationsApplied).toBe(1);
    expect(applyResponse.body.hash).toBe(sourceHash(studioSource));

    const diff = await api.post("/v1/agent/diff_script").send({ path: "ServerScriptService/PatchTarget", baseHash: originalHash });
    expect(diff.status).toBe(200);
    expect(diff.body.baseHash).toBe(originalHash);
    expect(diff.body.summary.changedHunks).toBeGreaterThan(0);
    expect(diff.body.hunks[0].removedLines.length).toBeGreaterThan(0);
    expect(diff.body.hunks[0].addedLines.length).toBeGreaterThan(0);
  });

  it("clones a UI subtree under one root through a single batch mutation", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: [
        {
          path: ["StarterGui", "MainGui", "TemplateCard"],
          service: "StarterGui",
          name: "TemplateCard",
          className: "Frame",
          version: "ui-template-card-v1",
          updatedAt: new Date().toISOString(),
          props: { BackgroundTransparency: 0 },
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "TemplateCard", "TitleLabel"],
              service: "StarterGui",
              name: "TitleLabel",
              className: "TextLabel",
              version: "ui-template-title-v1",
              updatedAt: new Date().toISOString(),
              props: { Text: "Shop Item" },
              unsupportedProperties: [],
              children: []
            }
          ]
        }
      ]
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const clonePromise = api
      .post("/v1/agent/clone_ui_subtree")
      .send({
        rootPath: "StarterGui/MainGui",
        sourcePath: "StarterGui/MainGui/TemplateCard",
        newParentPath: "StarterGui/MainGui",
        expectedVersion: "ui-root-v1",
        newName: "TemplateCardClone"
      })
      .then((response) => response);

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const refreshBeforeMutate = await pollOne(api, sessionId);
    expect(refreshBeforeMutate.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refreshBeforeMutate.commandId, { version: root.version });

    const mutate = await pollOne(api, sessionId);
    expect(mutate.type).toBe("mutate_ui_batch_if_version");
    expect(((mutate.payload as { operations: unknown[] }).operations || []).length).toBeGreaterThanOrEqual(2);
    await complete(api, sessionId, mutate.commandId, { ok: true });

    const refreshedRoot = {
      ...root,
      version: "ui-root-v2",
      children: [
        ...root.children,
        {
          path: ["StarterGui", "MainGui", "TemplateCardClone"],
          service: "StarterGui",
          name: "TemplateCardClone",
          className: "Frame",
          version: "ui-template-card-v2",
          updatedAt: new Date().toISOString(),
          props: { BackgroundTransparency: 0 },
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "TemplateCardClone", "TitleLabel"],
              service: "StarterGui",
              name: "TitleLabel",
              className: "TextLabel",
              version: "ui-template-title-v2",
              updatedAt: new Date().toISOString(),
              props: { Text: "Shop Item" },
              unsupportedProperties: [],
              children: []
            }
          ]
        }
      ]
    };
    const refreshAfter = await pollOne(api, sessionId);
    expect(refreshAfter.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [refreshedRoot], "partial");
    await complete(api, sessionId, refreshAfter.commandId, { version: refreshedRoot.version });

    const cloneResponse = await clonePromise;
    expect(cloneResponse.status).toBe(200);
    expect(cloneResponse.body.clonedPath).toBe("StarterGui/MainGui/TemplateCardClone");
    expect(cloneResponse.body.clonedNode.name).toBe("TemplateCardClone");
    expect(cloneResponse.body.root.version).toBe("ui-root-v2");
  });

  it("applies modal and shop_grid templates through one batch command each", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: []
    };

    const warm = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await warm;

    const modalValidate = await api.post("/v1/agent/validate_operation").send({
      kind: "ui_template",
      payload: {
        kind: "modal",
        rootPath: "StarterGui/MainGui",
        targetPath: "StarterGui/MainGui",
        expectedVersion: "ui-root-v1",
        options: { name: "RewardModal", title: "Daily Reward" }
      }
    });
    expect(modalValidate.status).toBe(200);
    expect(modalValidate.body.valid).toBe(true);

    const modalPromise = api
      .post("/v1/agent/apply_ui_template")
      .send({
        kind: "modal",
        rootPath: "StarterGui/MainGui",
        targetPath: "StarterGui/MainGui",
        expectedVersion: "ui-root-v1",
        options: { name: "RewardModal", title: "Daily Reward", bodyText: "Claim your gift" }
      })
      .then((response) => response);

    const modalRefresh = await pollOne(api, sessionId);
    expect(modalRefresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, modalRefresh.commandId, { version: root.version });

    const modalRefreshBeforeMutate = await pollOne(api, sessionId);
    expect(modalRefreshBeforeMutate.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, modalRefreshBeforeMutate.commandId, { version: root.version });

    const modalMutate = await pollOne(api, sessionId);
    expect(modalMutate.type).toBe("mutate_ui_batch_if_version");
    await complete(api, sessionId, modalMutate.commandId, { ok: true });

    const modalRoot = {
      ...root,
      version: "ui-root-v2",
      children: [
        {
          path: ["StarterGui", "MainGui", "RewardModal"],
          service: "StarterGui",
          name: "RewardModal",
          className: "Frame",
          version: "ui-modal-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "RewardModal", "RewardModal_TitleLabel"],
              service: "StarterGui",
              name: "RewardModal_TitleLabel",
              className: "TextLabel",
              version: "ui-modal-title-v1",
              updatedAt: new Date().toISOString(),
              props: { Text: "Daily Reward" },
              unsupportedProperties: [],
              children: []
            }
          ]
        }
      ]
    };
    const modalRefreshAfter = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [modalRoot], "partial");
    await complete(api, sessionId, modalRefreshAfter.commandId, { version: modalRoot.version });

    const modalResponse = await modalPromise;
    expect(modalResponse.status).toBe(200);
    expect(modalResponse.body.kind).toBe("modal");
    expect(modalResponse.body.appliedCount).toBeGreaterThan(0);

    const gridPromise = api
      .post("/v1/agent/apply_ui_template")
      .send({
        kind: "shop_grid",
        rootPath: "StarterGui/MainGui",
        targetPath: "StarterGui/MainGui",
        expectedVersion: "ui-root-v2",
        options: {
          name: "ShopGrid",
          title: "Featured Shop",
          columns: 2,
          sampleItems: [
            { name: "Sword", priceText: "100" },
            { name: "Shield", priceText: "250", badgeText: "Hot" }
          ]
        }
      })
      .then((response) => response);

    const gridRefresh = await pollOne(api, sessionId);
    expect(gridRefresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [modalRoot], "partial");
    await complete(api, sessionId, gridRefresh.commandId, { version: modalRoot.version });

    const gridRefreshBeforeMutate = await pollOne(api, sessionId);
    expect(gridRefreshBeforeMutate.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [modalRoot], "partial");
    await complete(api, sessionId, gridRefreshBeforeMutate.commandId, { version: modalRoot.version });

    const gridMutate = await pollOne(api, sessionId);
    expect(gridMutate.type).toBe("mutate_ui_batch_if_version");
    await complete(api, sessionId, gridMutate.commandId, { ok: true });

    const gridRoot = {
      ...modalRoot,
      version: "ui-root-v3",
      children: [
        ...modalRoot.children,
        {
          path: ["StarterGui", "MainGui", "ShopGrid"],
          service: "StarterGui",
          name: "ShopGrid",
          className: "Frame",
          version: "ui-grid-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "ShopGrid", "ShopGrid_GridHost"],
              service: "StarterGui",
              name: "ShopGrid_GridHost",
              className: "Frame",
              version: "ui-grid-host-v1",
              updatedAt: new Date().toISOString(),
              props: {},
              unsupportedProperties: [],
              children: []
            }
          ]
        }
      ]
    };
    const gridRefreshAfter = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [gridRoot], "partial");
    await complete(api, sessionId, gridRefreshAfter.commandId, { version: gridRoot.version });

    const gridResponse = await gridPromise;
    expect(gridResponse.status).toBe(200);
    expect(gridResponse.body.kind).toBe("shop_grid");
    expect(gridResponse.body.appliedCount).toBeGreaterThan(0);
    expect(gridResponse.body.root.children.some((child: { name: string }) => child.name === "ShopGrid")).toBe(true);
  });

  it("moves then deletes scripts through hash-locked tree mutation flows", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const source = "print('tree')\n";
    const oldPath = ["ServerScriptService", "OldFolder", "TreeScript"];
    const newParentPath = ["ServerScriptService", "NewFolder"];
    const newPath = [...newParentPath, "TreeScriptRenamed"];
    const cache = (bridge as unknown as { cache: CacheStore }).cache;

    await seedScripts(api, bridge, sessionId, [{ path: oldPath, class: "Script", source }]);

    const moveResponsePromise = bridge.moveScript(oldPath, newParentPath, sourceHash(source), "TreeScriptRenamed");

    const moveRefresh = await pollOne(api, sessionId, 100);
    expect(moveRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, oldPath, source);
    await complete(api, sessionId, moveRefresh.commandId);

    const moveCommand = await pollOne(api, sessionId, 100);
    expect(moveCommand.type).toBe("move_script_if_hash");
    await complete(api, sessionId, moveCommand.commandId, { moved: true, path: newPath });

    const moveRefreshAfter = await pollOne(api, sessionId, 100);
    expect(moveRefreshAfter.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, newPath, source);
    await complete(api, sessionId, moveRefreshAfter.commandId);

    const moveResponse = await moveResponsePromise;
    expect(moveResponse.path).toEqual(newPath);

    const deleteResponsePromise = bridge.deleteScript(newPath, sourceHash(source));

    const deleteRefresh = await pollOne(api, sessionId, 100);
    expect(deleteRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, newPath, source);
    await complete(api, sessionId, deleteRefresh.commandId);

    const deleteCommand = await pollOne(api, sessionId, 100);
    expect(deleteCommand.type).toBe("delete_script_if_hash");
    await complete(api, sessionId, deleteCommand.commandId, { deleted: true });

    const deleteVerify = await pollOne(api, sessionId, 100);
    expect(deleteVerify.type).toBe("snapshot_script_by_path");
    await completeError(api, sessionId, deleteVerify.commandId, "not_found", "Script not found", { path: newPath });

    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.deletedPath).toEqual(newPath);
    const listed = await cache.listScripts();
    expect(listed.some((item: { path: string[] }) => item.path.join("/") === newPath.join("/"))).toBe(false);
  });

  it("supports rename-via-move into service root", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const source = "return {}\n";
    const oldPath = ["ServerScriptService", "FolderA", "RootRenameScript"];
    const newParentPath = ["ServerScriptService"];
    const newPath = ["ServerScriptService", "RootRenameScriptRenamed"];

    await seedScripts(api, bridge, sessionId, [{ path: oldPath, class: "ModuleScript", source }]);

    const moveResponsePromise = bridge.moveScript(oldPath, newParentPath, sourceHash(source), "RootRenameScriptRenamed");

    const moveRefresh = await pollOne(api, sessionId, 100);
    expect(moveRefresh.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, oldPath, source);
    await complete(api, sessionId, moveRefresh.commandId);

    const moveCommand = await pollOne(api, sessionId, 100);
    expect(moveCommand.type).toBe("move_script_if_hash");
    await complete(api, sessionId, moveCommand.commandId, { moved: true, path: newPath });

    const moveRefreshAfter = await pollOne(api, sessionId, 100);
    expect(moveRefreshAfter.type).toBe("snapshot_script_by_path");
    await pushPartial(api, sessionId, newPath, source);
    await complete(api, sessionId, moveRefreshAfter.commandId);

    const moveResponse = await moveResponsePromise;
    expect(moveResponse.path).toEqual(newPath);
  });

  it("captures layout snapshots and returns machine-friendly layout issues", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "layout-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: []
    };

    const uiListPromise = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await uiListPromise;

    const responsePromise = bridge.validateUiLayout(["StarterGui", "MainGui"], { forceRefresh: true });

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const layoutCommand = await pollOne(api, sessionId);
    expect(layoutCommand.type).toBe("snapshot_ui_layout_by_path");
    await complete(api, sessionId, layoutCommand.commandId, {
      root: {
        path: ["StarterGui", "MainGui"],
        className: "ScreenGui",
        visible: true,
        active: false,
        anchorPoint: { type: "Vector2", x: 0, y: 0 },
        position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 0 }, y: { type: "UDim", scale: 0, offset: 0 } },
        size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: 0 }, y: { type: "UDim", scale: 1, offset: 0 } },
        absolutePosition: { x: 0, y: 0 },
        absoluteSize: { x: 500, y: 400 },
        zIndex: 1,
        clipsDescendants: false,
        children: [
          {
            path: ["StarterGui", "MainGui", "ButtonA"],
            className: "TextButton",
            visible: true,
            active: true,
            anchorPoint: { type: "Vector2", x: 0, y: 0 },
            position: null,
            size: null,
            absolutePosition: { x: 10, y: 10 },
            absoluteSize: { x: 150, y: 50 },
            zIndex: 2,
            clipsDescendants: false,
            text: "Buy",
            textBounds: { x: 40, y: 20 },
            textScaled: false,
            textWrapped: false,
            children: []
          },
          {
            path: ["StarterGui", "MainGui", "ButtonB"],
            className: "TextButton",
            visible: true,
            active: true,
            anchorPoint: { type: "Vector2", x: 0, y: 0 },
            position: null,
            size: null,
            absolutePosition: { x: 100, y: 30 },
            absoluteSize: { x: 150, y: 50 },
            zIndex: 2,
            clipsDescendants: false,
            text: "Buy",
            textBounds: { x: 40, y: 20 },
            textScaled: false,
            textWrapped: false,
            children: []
          },
          {
            path: ["StarterGui", "MainGui", "ZeroSize"],
            className: "Frame",
            visible: true,
            active: false,
            anchorPoint: { type: "Vector2", x: 0, y: 0 },
            position: null,
            size: null,
            absolutePosition: { x: 700, y: 10 },
            absoluteSize: { x: 0, y: 0 },
            zIndex: 1,
            clipsDescendants: false,
            children: []
          }
        ]
      },
      rootClassName: "ScreenGui",
      screenSpace: true,
      partialGeometryOnly: false
    });

    const response = await responsePromise;
    expect(response.issues.some((issue: { code: string }) => issue.code === "overlap")).toBe(true);
    expect(response.issues.some((issue: { code: string }) => issue.code === "zero_size")).toBe(true);
    expect(response.issues.some((issue: { code: string }) => issue.code === "offscreen")).toBe(true);
  });

  it("resolves UI batch refs server-side without new plugin primitives", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "ui-ref-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: []
    };

    const uiListPromise = bridge.listUiRoots();
    const snapshotAll = await pollOne(api, sessionId);
    expect(snapshotAll.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotAll.commandId, { count: 1 });
    await uiListPromise;

    const responsePromise = bridge.applyUiBatch(
      ["StarterGui", "MainGui"],
      "ui-ref-root-v1",
      [
        { op: "create_node", parentPath: ["StarterGui", "MainGui"], className: "Frame", name: "Panel", id: "panel" },
        { op: "create_node", parentRef: "panel", className: "TextButton", name: "BuyButton", id: "button" },
        { op: "update_props", pathRef: "button", props: { Text: "Buy" } }
      ]
    );

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [root], "partial");
    await complete(api, sessionId, refresh.commandId, { version: root.version });

    const mutate = await pollOne(api, sessionId);
    expect(mutate.type).toBe("mutate_ui_batch_if_version");
    const operations = (mutate.payload.operations as Array<Record<string, unknown>>);
    expect(operations[0].parentPath).toEqual(["StarterGui", "MainGui"]);
    expect(operations[1].parentPath).toEqual(["StarterGui", "MainGui", "Panel"]);
    expect(operations[2].path).toEqual(["StarterGui", "MainGui", "Panel", "BuyButton"]);
    await complete(api, sessionId, mutate.commandId, { ok: true });

    const rootAfter = {
      ...root,
      version: "ui-ref-root-v2",
      children: [
        {
          path: ["StarterGui", "MainGui", "Panel"],
          service: "StarterGui",
          name: "Panel",
          className: "Frame",
          version: "panel-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "Panel", "BuyButton"],
              service: "StarterGui",
              name: "BuyButton",
              className: "TextButton",
              version: "button-v1",
              updatedAt: new Date().toISOString(),
              props: { Text: "Buy" },
              unsupportedProperties: [],
              children: []
            }
          ]
        }
      ]
    };
    const refreshAfter = await pollOne(api, sessionId);
    await pushUiRoots(api, sessionId, [rootAfter], "partial");
    await complete(api, sessionId, refreshAfter.commandId, { version: rootAfter.version });

    const response = await responsePromise;
    expect(response.resolvedRefs.panel).toEqual(["StarterGui", "MainGui", "Panel"]);
    expect(response.resolvedRefs.button).toEqual(["StarterGui", "MainGui", "Panel", "BuyButton"]);
  });

  it("returns heuristic UI bindings and compact retrieval results in minimal mode", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);

    await seedScripts(api, bridge, sessionId, [
      {
        path: ["StarterGui", "MainGui", "ShopController"],
        class: "LocalScript",
        source: "local button = script.Parent:WaitForChild('BuyButton')\nbutton.Activated:Connect(function() end)\n"
      },
      {
        path: ["ReplicatedStorage", "Remotes", "TradeClient"],
        class: "ModuleScript",
        source: "game.ReplicatedStorage.Remotes.TradeRequest:FireServer('buy', 1)\n"
      },
      {
        path: ["ServerScriptService", "TradeServer"],
        class: "Script",
        source: "game.ReplicatedStorage.Remotes.TradeRequest.OnServerEvent:Connect(function(player, action) end)\n"
      }
    ]);

    const root = {
      path: ["StarterGui", "MainGui"],
      service: "StarterGui",
      name: "MainGui",
      className: "ScreenGui",
      version: "binding-root-v1",
      updatedAt: new Date().toISOString(),
      props: {},
      unsupportedProperties: [],
      children: [
        {
          path: ["StarterGui", "MainGui", "BuyButton"],
          service: "StarterGui",
          name: "BuyButton",
          className: "TextButton",
          version: "buy-button-v1",
          updatedAt: new Date().toISOString(),
          props: { Text: "Buy" },
          unsupportedProperties: [],
          children: []
        }
      ]
    };
    const uiListPromise = bridge.listUiRoots();
    const snapshotUi = await pollOne(api, sessionId);
    expect(snapshotUi.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, snapshotUi.commandId, { count: 1 });
    await uiListPromise;

    const bindingsResponse = await api.post("/v1/agent/find_ui_bindings").send({
      target: { uiPath: "StarterGui/MainGui/BuyButton" }
    });
    expect(bindingsResponse.status).toBe(200);
    expect(bindingsResponse.body.bindings.length).toBeGreaterThan(0);
    expect(bindingsResponse.body.bindings[0].scriptPath).toBe("StarterGui/MainGui/ShopController");

    const remotesResponse = await api.post("/v1/agent/find_remotes").send({
      query: "TradeRequest",
      verbosity: "minimal"
    });
    expect(remotesResponse.status).toBe(200);
    expect(remotesResponse.body.remotes.length).toBeGreaterThan(0);
    expect(remotesResponse.body.remotes[0].confidence).toBeGreaterThan(0);
    expect(typeof remotesResponse.body.remotes[0].unresolvedPath).toBe("boolean");
    expect(remotesResponse.body.remotes[0].evidence.length).toBeGreaterThan(0);
    expect(remotesResponse.body.remotes[0].pairedParticipants.length).toBeGreaterThan(0);
    expect(remotesResponse.body.remotes.some((remote: { name: string }) => remote.name.includes("RemoteEvent)"))).toBe(false);

    const summaryResponse = await api.post("/v1/agent/get_project_summary").send({
      verbosity: "minimal"
    });
    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.body.scripts.likelyEntrypoints.length).toBeLessThanOrEqual(3);
  });

  it("suppresses helper-node layout noise and filters string literal references", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);

    await seedScripts(api, bridge, sessionId, [
      {
        path: ["StarterGui", "HUD", "UI_HUD"],
        class: "LocalScript",
        source: "local UI_HUD = {}\nlocal button = script.Parent.Container:WaitForChild('BuyButton')\nbutton.Activated:Connect(function() return UI_HUD end)\nreturn UI_HUD\n"
      },
      {
        path: ["StarterGui", "HUD", "Logger"],
        class: "LocalScript",
        source: "-- UI_HUD comment should not count\nwarn('[UI_HUD] opened')\nreturn [[UI_HUD string block]]\n"
      }
    ]);

    const uiListPromise = bridge.listUiRoots();
    const snapshotUi = await pollOne(api, sessionId);
    expect(snapshotUi.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [
      {
        path: ["StarterGui", "HUD"],
        service: "StarterGui",
        name: "HUD",
        className: "ScreenGui",
        version: "hud-root-v1",
        updatedAt: new Date().toISOString(),
        props: {},
        unsupportedProperties: [],
        children: [
          {
            path: ["StarterGui", "HUD", "Container"],
            service: "StarterGui",
            name: "Container",
            className: "Frame",
            version: "hud-container-v1",
            updatedAt: new Date().toISOString(),
            props: {},
            unsupportedProperties: [],
            children: [
              {
                path: ["StarterGui", "HUD", "Container", "List"],
                service: "StarterGui",
                name: "List",
                className: "UIListLayout",
                version: "hud-list-v1",
                updatedAt: new Date().toISOString(),
                props: {},
                unsupportedProperties: [],
                children: []
              },
              {
                path: ["StarterGui", "HUD", "Container", "Corner"],
                service: "StarterGui",
                name: "Corner",
                className: "UICorner",
                version: "hud-corner-v1",
                updatedAt: new Date().toISOString(),
                props: {},
                unsupportedProperties: [],
                children: []
              },
              {
                path: ["StarterGui", "HUD", "Container", "BuyButton"],
                service: "StarterGui",
                name: "BuyButton",
                className: "TextButton",
                version: "hud-button-v1",
                updatedAt: new Date().toISOString(),
                props: { Text: "Buy" },
                unsupportedProperties: [],
                children: []
              }
            ]
          }
        ]
      }
    ], "all");
    await complete(api, sessionId, snapshotUi.commandId, { count: 1 });
    await uiListPromise;

    const layoutPromise = bridge.validateUiLayout(["StarterGui", "HUD"], { forceRefresh: true, verbosity: "minimal" });

    const refresh = await pollOne(api, sessionId);
    expect(refresh.type).toBe("snapshot_ui_subtree_by_path");
    await pushUiRoots(api, sessionId, [
      {
        path: ["StarterGui", "HUD"],
        service: "StarterGui",
        name: "HUD",
        className: "ScreenGui",
        version: "hud-root-v1",
        updatedAt: new Date().toISOString(),
        props: {},
        unsupportedProperties: [],
        children: []
      }
    ], "partial");
    await complete(api, sessionId, refresh.commandId, { version: "hud-root-v1" });

    const layoutCommand = await pollOne(api, sessionId);
    expect(layoutCommand.type).toBe("snapshot_ui_layout_by_path");
    await complete(api, sessionId, layoutCommand.commandId, {
      root: {
        path: ["StarterGui", "HUD"],
        className: "ScreenGui",
        visible: true,
        active: false,
        anchorPoint: { type: "Vector2", x: 0, y: 0 },
        position: null,
        size: null,
        absolutePosition: { x: 0, y: 0 },
        absoluteSize: { x: 600, y: 400 },
        zIndex: 1,
        clipsDescendants: false,
        children: [
          {
            path: ["StarterGui", "HUD", "Container"],
            className: "Frame",
            visible: true,
            active: false,
            anchorPoint: { type: "Vector2", x: 0, y: 0 },
            position: null,
            size: null,
            absolutePosition: { x: 10, y: 10 },
            absoluteSize: { x: 220, y: 120 },
            zIndex: 1,
            clipsDescendants: false,
            children: [
              {
                path: ["StarterGui", "HUD", "Container", "Corner"],
                className: "UICorner",
                visible: true,
                active: false,
                anchorPoint: { type: "Vector2", x: 0, y: 0 },
                position: null,
                size: null,
                absolutePosition: { x: 10, y: 10 },
                absoluteSize: { x: 0, y: 0 },
                zIndex: 1,
                clipsDescendants: false,
                children: []
              },
              {
                path: ["StarterGui", "HUD", "Container", "BuyButton"],
                className: "TextButton",
                visible: true,
                active: true,
                anchorPoint: { type: "Vector2", x: 0, y: 0 },
                position: null,
                size: null,
                absolutePosition: { x: 20, y: 20 },
                absoluteSize: { x: 140, y: 40 },
                zIndex: 2,
                clipsDescendants: false,
                text: "Buy",
                textBounds: { x: 30, y: 18 },
                textScaled: false,
                textWrapped: false,
                children: []
              }
            ]
          }
        ]
      },
      partialGeometryOnly: false,
      screenSpace: true
    });

    const layoutResponse = await layoutPromise;
    expect(layoutResponse.summary).toBeTruthy();
    expect(typeof layoutResponse.summary.suppressedHelperChecks).toBe("number");
    expect(layoutResponse.issues.length).toBeLessThanOrEqual(10);
    expect(layoutResponse.issues.some((issue: { path: string[] }) => issue.path.join("/").includes("Corner"))).toBe(false);

    const symbolContext = await api.post("/v1/agent/get_symbol_context").send({
      symbol: "UI_HUD",
      verbosity: "minimal"
    });
    expect(symbolContext.status).toBe(200);
    expect(symbolContext.body.references.some((reference: { path: string }) => reference.path === "StarterGui/HUD/Logger")).toBe(false);

    const uiSummary = await api.post("/v1/agent/get_ui_summary").send({
      path: "StarterGui/HUD",
      verbosity: "minimal"
    });
    expect(uiSummary.status).toBe(200);
    expect(uiSummary.body.bindingHints.length).toBeGreaterThan(0);
    expect(uiSummary.body.bindingHints[0].reason).toMatch(/heuristic:/);

    const journal = await api.post("/v1/agent/get_changed_since").send({
      cursorOrTimestamp: "0",
      limit: 1
    });
    expect(journal.status).toBe(200);
    expect(journal.body.items).toHaveLength(1);
    expect(journal.body.nextCursor).toBeTruthy();
  });

  it("captures runtime logs through agent endpoints", async () => {
    const { api } = await createContext();
    const sessionId = await hello(api);

    const pushLogsResponse = await api.post("/v1/studio/push_logs").send({
      sessionId,
      entries: [
        {
          id: "log-1",
          time: new Date().toISOString(),
          level: "warn",
          message: "runtime warning",
          source: "client"
        }
      ]
    });
    expect(pushLogsResponse.status).toBe(200);

    const logsResponse = await api.post("/v1/agent/get_logs").send({ minLevel: "warn", limit: 10 });
    expect(logsResponse.status).toBe(200);
    expect(logsResponse.body.items).toHaveLength(1);
    expect(logsResponse.body.items[0].message).toBe("runtime warning");
  });

  it("keeps healthz responsive while studio poll is waiting", async () => {
    const { api } = await createContext();
    const sessionId = await hello(api);

    const pollPromise = api.post("/v1/studio/poll").send({ sessionId, waitMs: 25_000 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = Date.now();
    const healthResponse = await api.get("/healthz");
    const elapsedMs = Date.now() - startedAt;

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);

    const pollResponse = await pollPromise;
    expect(pollResponse.status).toBe(200);
    expect(Array.isArray(pollResponse.body.commands)).toBe(true);
  });

  it("marks stale studio sessions as offline in health", async () => {
    const { bridge } = await createContext();
    const session = (bridge as any).sessions.registerHello({
      clientId: "plugin-1",
      placeId: "place-123",
      placeName: "Arena",
      pluginVersion: "0.1.8",
      editorApiAvailable: true,
      base64Transport: true,
      logCaptureAvailable: true
    }).session;

    const staleAt = new Date(Date.now() - 20_000).toISOString();
    session.lastSeenAt = staleAt;
    session.lastPollAt = staleAt;

    const health = bridge.health();
    expect(health.studioOnline).toBe(false);
    expect(health.scriptReadOk).toBe(false);
    expect(health.scriptWriteOk).toBe(false);
    expect(health.uiWriteOk).toBe(false);
    expect(health.session?.stale).toBe(true);
  });
});
