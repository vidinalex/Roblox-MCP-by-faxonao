import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request, { SuperTest, Test } from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeService } from "../src/bridge/bridgeService.js";
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

async function createContext() {
  const tempDir = await mkdtemp(join(tmpdir(), "rbxmcp-retrieval-"));
  contexts.push({ tempDir });
  const cache = new CacheStore(tempDir);
  const bridge = new BridgeService(cache);
  await bridge.bootstrap();
  const app = createBridgeHttpApp(bridge);
  return { api: request(app), bridge };
}

async function hello(api: SuperTest<Test>): Promise<string> {
  const response = await api.post("/v1/studio/hello").send({
    clientId: "plugin-retrieval",
    placeId: "place-retrieval",
    placeName: "RetrievalPlace",
    pluginVersion: "0.1.9",
    editorApiAvailable: true,
    base64Transport: true
  });
  expect(response.status).toBe(200);
  return response.body.sessionId as string;
}

async function pollOne(api: SuperTest<Test>, sessionId: string, waitMs = 1000): Promise<StudioCommand> {
  const poll = await api.post("/v1/studio/poll").send({ sessionId, waitMs });
  expect(poll.status).toBe(200);
  expect(Array.isArray(poll.body.commands)).toBe(true);
  expect(poll.body.commands.length).toBeGreaterThan(0);
  return poll.body.commands[0] as StudioCommand;
}

async function pushSnapshot(
  api: SuperTest<Test>,
  sessionId: string,
  mode: "all" | "partial",
  scripts: Array<{ path: string[]; class: string; source: string }>
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

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) {
      await rm(ctx.tempDir, { recursive: true, force: true });
    }
  }
});

describe("retrieval tools", () => {
  it("indexes text/symbols/references/dependencies/impact/range/context", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const modulePath = ["ReplicatedStorage", "Utils", "Greeter"];
    const consumerPath = ["ServerScriptService", "Main"];
    await seedScripts(api, bridge, sessionId, [
      {
        path: modulePath,
        class: "ModuleScript",
        source:
          "local M = {}\n\nfunction M.hello(name)\n    return 'привет, ' .. name\nend\n\nreturn M\n"
      },
      {
        path: consumerPath,
        class: "Script",
        source:
          "local Greeter = require(game.ReplicatedStorage.Utils.Greeter)\nprint(Greeter.hello('world'))\n"
      }
    ]);

    const search = await bridge.searchText("привет", { limit: 10 });
    expect(search.length).toBeGreaterThan(0);
    expect(search[0].path).toEqual(modulePath);

    const symbols = await bridge.findSymbols({ name: "hello", limit: 20 });
    expect(symbols.some((symbol) => symbol.path.join("/") === modulePath.join("/"))).toBe(true);

    const refs = await bridge.findReferences("Greeter", { limit: 50 });
    expect(refs.some((reference) => reference.path.join("/") === consumerPath.join("/"))).toBe(true);

    const deps = await bridge.getDependencies(consumerPath, 2);
    expect(deps).not.toBeNull();
    expect(deps?.edges.some((edge) => edge.to.join("/") === modulePath.join("/"))).toBe(true);

    const impact = await bridge.getImpact(modulePath, 2);
    expect(impact).not.toBeNull();
    expect(impact?.impactedNodes.some((node) => node.path.join("/") === consumerPath.join("/"))).toBe(true);

    const range = await bridge.getScriptRange(modulePath, 3, 5);
    expect(range?.actualStartLine).toBe(3);
    expect(range?.actualEndLine).toBe(5);
    expect(range?.content).toContain("function M.hello");

    const bundle = await bridge.getContextBundle({
      entryPaths: [consumerPath],
      query: "hello",
      budgetTokens: 250,
      dependencyDepth: 2
    });
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.usedBudget).toBeLessThanOrEqual(250);
  });

  it("uses batch snapshot command for refresh_scripts", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const pathA = ["StarterGui", "UiA"];
    const pathB = ["StarterGui", "UiB"];
    await seedScripts(api, bridge, sessionId, [
      { path: pathA, class: "LocalScript", source: "print('a1')" },
      { path: pathB, class: "LocalScript", source: "print('b1')" }
    ]);

    const refreshPromise = bridge.refreshScripts([pathA, pathB]);
    const batchCommand = await pollOne(api, sessionId);
    expect(batchCommand.type).toBe("snapshot_scripts_by_paths");
    expect(batchCommand.timeoutMs).toBe(60_000);
    await pushSnapshot(api, sessionId, "partial", [
      { path: pathA, class: "LocalScript", source: "print('a2')" },
      { path: pathB, class: "LocalScript", source: "print('b2')" }
    ]);
    await complete(api, sessionId, batchCommand.commandId, { requested: 2, found: 2 });
    const refreshed = await refreshPromise;
    expect(refreshed.refreshed).toBe(2);
    expect(refreshed.failed).toBe(0);
  });

  it("falls back to per-script refresh when batch command is unsupported", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const pathA = ["StarterGui", "UiA"];
    const pathB = ["StarterGui", "UiB"];
    await seedScripts(api, bridge, sessionId, [
      { path: pathA, class: "LocalScript", source: "print('a1')" },
      { path: pathB, class: "LocalScript", source: "print('b1')" }
    ]);

    const refreshPromise = bridge.refreshScripts([pathA, pathB]);
    const batchCommand = await pollOne(api, sessionId);
    expect(batchCommand.type).toBe("snapshot_scripts_by_paths");
    const unsupported = await api.post("/v1/studio/result").send({
      sessionId,
      commandId: batchCommand.commandId,
      ok: false,
      error: {
        code: "unsupported_command",
        message: "not implemented"
      }
    });
    expect(unsupported.status).toBe(200);

    const refreshA = await pollOne(api, sessionId);
    expect(refreshA.type).toBe("snapshot_script_by_path");
    await pushSnapshot(api, sessionId, "partial", [{ path: pathA, class: "LocalScript", source: "print('a2')" }]);
    await complete(api, sessionId, refreshA.commandId);

    const refreshB = await pollOne(api, sessionId);
    expect(refreshB.type).toBe("snapshot_script_by_path");
    await pushSnapshot(api, sessionId, "partial", [{ path: pathB, class: "LocalScript", source: "print('b2')" }]);
    await complete(api, sessionId, refreshB.commandId);

    const refreshed = await refreshPromise;
    expect(refreshed.refreshed).toBe(2);
    expect(refreshed.failed).toBe(0);
  });

  it("keeps index consistent across sequential hash-locked updates", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const path = ["ServerScriptService", "MainScript"];
    let studioSource = "print('alpha')\n";

    await seedScripts(api, bridge, sessionId, [{ path, class: "Script", source: studioSource }]);
    const update1 = bridge.updateScript(path, "print('beta_token')\n", sourceHash(studioSource));

    const write1 = await pollOne(api, sessionId);
    expect(write1.type).toBe("set_script_source_if_hash");
    studioSource = "print('beta_token')\n";
    await complete(api, sessionId, write1.commandId, {
      path,
      hash: sourceHash(studioSource),
      className: "Script",
      writeChannel: "editor",
      readChannel: "editor",
      draftAware: true
    });
    const verify1 = await pollOne(api, sessionId);
    expect(verify1.type).toBe("snapshot_script_by_path");
    await pushSnapshot(api, sessionId, "partial", [{ path, class: "Script", source: studioSource }]);
    await complete(api, sessionId, verify1.commandId);
    const done1 = await update1;
    expect(done1.hash).toBe(sourceHash(studioSource));

    const search = await bridge.searchText("beta_token", { limit: 10 });
    expect(search.some((hit) => hit.path.join("/") === path.join("/"))).toBe(true);
  });

  it("builds compact project summary and related context", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const modulePath = ["ReplicatedStorage", "Ui", "ShopController"];
    const consumerPath = ["StarterGui", "MainGui", "Shop.client"];
    await seedScripts(api, bridge, sessionId, [
      {
        path: modulePath,
        class: "ModuleScript",
        source: "local M = {}\nfunction M.openShop() return true end\nreturn M\n"
      },
      {
        path: consumerPath,
        class: "LocalScript",
        source: "local ShopController = require(game.ReplicatedStorage.Ui.ShopController)\nShopController.openShop()\n"
      }
    ]);

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
    const warmUi = bridge.listUiRoots();
    const uiSnapshot = await pollOne(api, sessionId);
    expect(uiSnapshot.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });
    await warmUi;

    const summary = await bridge.getProjectSummary("all");
    expect(summary.scripts.totalScripts).toBe(2);
    expect(summary.ui.rootCount).toBe(1);
    expect(summary.highlights.length).toBeGreaterThan(0);

    const relatedBySymbol = await bridge.getRelatedContext({ symbol: "openShop" }, 1000);
    expect(relatedBySymbol.target.kind).toBe("symbol");
    expect(relatedBySymbol.relatedScripts.some((item: { path: string[] }) => item.path.join("/") === consumerPath.join("/"))).toBe(true);

    const relatedByQuery = await bridge.getRelatedContext({ query: "Shop" }, 1000);
    expect(relatedByQuery.relatedUi.some((item: { path: string[] }) => item.path.join("/") === root.children[0].path.join("/"))).toBe(true);
  });

  it("truncates oversized source before retrieval indexing", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const largeSource = `return [[${"x".repeat(300_000)}]]`;
    const scriptPath = ["ReplicatedStorage", "Bench", "HugeModule"];

    await seedScripts(api, bridge, sessionId, [
      {
        path: scriptPath,
        class: "ModuleScript",
        source: largeSource
      }
    ]);

    const indexed = [...(bridge as any).index.scripts.values()].find(
      (item: { path: string[] }) => item.path.join("/") === scriptPath.join("/")
    );
    expect(indexed).toBeTruthy();
    expect(typeof indexed.source).toBe("string");
    expect(indexed.source.length).toBeLessThan(70_000);
    expect(indexed.source).toContain("source truncated for retrieval index");
  });

  it("summarizes UI tree and explains common errors", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    await seedScripts(api, bridge, sessionId, [
      {
        path: ["StarterGui", "MainGui", "Shop.client"],
        class: "LocalScript",
        source: "print('Open Shop button clicked')\n"
      },
      {
        path: ["ReplicatedStorage", "_Index", "vendor", "topbarplus"],
        class: "ModuleScript",
        source: "local button = {}\nbutton.MouseButton1Click = nil\nreturn button\n"
      }
    ]);
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
          path: ["StarterGui", "MainGui", "Content"],
          service: "StarterGui",
          name: "Content",
          className: "Frame",
          version: "ui-content-v1",
          updatedAt: new Date().toISOString(),
          props: {},
          unsupportedProperties: [],
          children: [
            {
              path: ["StarterGui", "MainGui", "Content", "List"],
              service: "StarterGui",
              name: "List",
              className: "UIListLayout",
              version: "ui-layout-v1",
              updatedAt: new Date().toISOString(),
              props: {},
              unsupportedProperties: [],
              children: []
            },
            {
              path: ["StarterGui", "MainGui", "Content", "ShopButton"],
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
        }
      ]
    };
    const warmUi = bridge.listUiRoots();
    const uiSnapshot = await pollOne(api, sessionId);
    expect(uiSnapshot.type).toBe("snapshot_ui_roots");
    await pushUiRoots(api, sessionId, [root], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });
    await warmUi;

    const summary = await bridge.getUiSummary(["StarterGui", "MainGui"], { forceRefresh: false });
    expect(summary.nodeCount).toBeGreaterThanOrEqual(4);
    expect(summary.classHistogram.some((item: { label: string }) => item.label === "TextButton")).toBe(true);
    expect(summary.layoutPrimitives.some((item: { label: string }) => item.label === "UIListLayout")).toBe(true);
    expect(summary.bindingHints.length).toBeGreaterThan(0);
    expect(summary.bindingHints[0].path.join("/")).toBe("StarterGui/MainGui/Shop.client");

    const explained = bridge.explainError("hash_conflict");
    expect(explained.retryable).toBe(true);
    expect(explained.recommendedNextCall?.endpoint).toBe("/v1/agent/get_script");
  });

  it("builds entrypoints, remote graph, relevance ranking, and symbol context", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const serverBootstrap = ["ServerScriptService", "Bootstrap.server"];
    const clientController = ["StarterGui", "MainGui", "Shop.client"];
    const sharedModule = ["ReplicatedStorage", "Shared", "RemoteNames"];
    await seedScripts(api, bridge, sessionId, [
      {
        path: serverBootstrap,
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
        path: clientController,
        class: "LocalScript",
        source: [
          "local Remotes = game.ReplicatedStorage.Remotes",
          "local BuyRemote = Remotes:WaitForChild('BuyItem')",
          "script.Parent.ShopButton.Activated:Connect(function()",
          "    BuyRemote:FireServer('Sword')",
          "end)"
        ].join("\n")
      },
      {
        path: sharedModule,
        class: "ModuleScript",
        source: "local M = {}\nfunction M.getBuyRemoteName() return 'BuyItem' end\nreturn M\n"
      }
    ]);
    const warmUi = bridge.listUiRoots();
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
            props: { Text: "Buy" },
            unsupportedProperties: [],
            children: []
          }
        ]
      }
    ], "all");
    await complete(api, sessionId, uiSnapshot.commandId, { count: 1 });
    await warmUi;

    const entrypoints = await bridge.findEntrypoints(undefined, undefined, 20);
    expect(
      entrypoints.some(
        (item) =>
          item.path.join("/") === serverBootstrap.join("/") &&
          (item.category === "server_bootstrap" || item.category === "remote_handler")
      )
    ).toBe(true);
    expect(entrypoints.some((item) => item.path.join("/") === clientController.join("/") && item.category === "ui_controller")).toBe(true);

    const remotes = await bridge.findRemotes("BuyRemote", 20);
    expect(remotes.length).toBeGreaterThan(0);
    expect(remotes[0].name).toContain("BuyRemote");
    expect(remotes[0].emitters.some((item) => item.path.join("/") === clientController.join("/"))).toBe(true);
    expect(remotes[0].handlers.some((item) => item.path.join("/") === serverBootstrap.join("/"))).toBe(true);

    const ranked = await bridge.rankFilesByRelevance("BuyRemote", 10);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].why.length).toBeGreaterThan(0);
    expect(ranked.some((item) => item.path.join("/") === clientController.join("/"))).toBe(true);

    const symbolContext = await bridge.getSymbolContext("getBuyRemoteName", 900);
    expect(symbolContext.definition?.path).toEqual(sharedModule);
    expect(symbolContext.chunks.length).toBeGreaterThan(0);
    expect(symbolContext.recommendedNextCalls).toContain("rbx_get_related_context");
  });

  it("filters string/comment false positives from references and symbol context", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    const targetPath = ["StarterGui", "MainGui", "HUDController"];
    const otherPath = ["StarterGui", "MainGui", "Logger"];
    await seedScripts(api, bridge, sessionId, [
      {
        path: targetPath,
        class: "LocalScript",
        source: [
          "local UI_HUD = {}",
          "function UI_HUD.show()",
          "    return true",
          "end",
          "return UI_HUD"
        ].join("\n")
      },
      {
        path: otherPath,
        class: "LocalScript",
        source: [
          "-- UI_HUD should not count from comments",
          "warn('[UI_HUD] opened')",
          "warn(`[UI_HUD] interpolated text`)",
          "local label = [[UI_HUD text block]]",
          "return label"
        ].join("\n")
      }
    ]);

    const refs = await bridge.findReferences("UI_HUD", { limit: 20 });
    expect(refs.some((reference) => reference.path.join("/") === targetPath.join("/"))).toBe(true);
    expect(refs.some((reference) => reference.path.join("/") === otherPath.join("/"))).toBe(false);
    expect(refs.filter((reference) => reference.isDefinition)).toHaveLength(1);
    expect(refs.some((reference) => reference.line === 5 && reference.isDefinition)).toBe(false);

    const context = await bridge.getSymbolContext("UI_HUD", 800, "minimal");
    expect(context.references.some((reference) => reference.path.join("/") === otherPath.join("/"))).toBe(false);
    expect(context.references.filter((reference) => reference.isDefinition)).toHaveLength(1);
  });

  it("keeps noisy unresolved remote names out of top results", async () => {
    const { api, bridge } = await createContext();
    const sessionId = await hello(api);
    await seedScripts(api, bridge, sessionId, [
      {
        path: ["ServerScriptService", "RemoteHandler"],
        class: "Script",
        source: "game.ReplicatedStorage.Remotes.BuyItem.OnServerEvent:Connect(function() end)"
      },
      {
        path: ["StarterGui", "MainGui", "RemoteClient"],
        class: "LocalScript",
        source: "local remote = (game.ReplicatedStorage:WaitForChild('Remotes'):WaitForChild('BuyItem') :: RemoteEvent)\nremote:FireServer('x')"
      },
      {
        path: ["ReplicatedStorage", "Shared", "Noisy"],
        class: "ModuleScript",
        source: "local x = tostring(RemoteEvent))\nreturn x"
      }
    ]);

    const remotes = await bridge.findRemotes(undefined, 20, "minimal");
    expect(remotes.length).toBeGreaterThan(0);
    expect(remotes[0].name).toBe("BuyItem");
    expect(remotes.some((remote) => remote.name.includes("RemoteEvent)"))).toBe(false);
  });
});
