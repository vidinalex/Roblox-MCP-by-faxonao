import { CacheStore } from "./server/dist/cache/cacheStore.js";
import { BridgeService } from "./server/dist/bridge/bridgeService.js";
import { sourceHash } from "./server/dist/lib/hash.js";
import { pathKey } from "./server/dist/lib/path.js";

function logRequest(name, args) {
  console.log("=== REQUEST ===");
  console.log(JSON.stringify({ api: name, args }, null, 2));
}

function logResponse(name, payload, isError = false) {
  console.log("=== RESPONSE ===");
  if (isError) {
    console.log(JSON.stringify({ api: name, error: payload }, null, 2));
  } else {
    console.log(JSON.stringify({ api: name, result: payload }, null, 2));
  }
}

async function callApi(name, args, fn) {
  logRequest(name, args);
  try {
    const result = await fn();
    logResponse(name, result, false);
    return result;
  } catch (error) {
    logResponse(
      name,
      {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? error.code : null
      },
      true
    );
    return null;
  }
}

async function main() {
  const cache = new CacheStore(process.cwd());
  const bridge = new BridgeService(cache);
  await bridge.bootstrap();

  const metadata = cache.metadata();
  if (!metadata) {
    throw new Error("Cache metadata is empty. Start Studio+plugin and run snapshot first.");
  }

  const allScripts = await cache.listAllScriptsWithSource();
  const studioState = new Map(allScripts.map((script) => [pathKey(script.path), { ...script }]));

  const helloInput = {
    clientId: "api-audit-runner",
    placeId: metadata.placeId,
    placeName: metadata.placeName,
    pluginVersion: "0.1.9-audit",
    editorApiAvailable: true,
    base64Transport: true
  };

  const session = await callApi("hello", helloInput, () => bridge.hello(helloInput));
  if (!session?.sessionId) {
    throw new Error("Failed to open local bridge session");
  }

  const sessionId = session.sessionId;
  let running = true;

  const worker = (async () => {
    while (running) {
      const commands = await bridge.poll(sessionId, 100);
      if (!Array.isArray(commands) || commands.length === 0) {
        continue;
      }
      for (const command of commands) {
        const type = command.type;
        const payload = command.payload || {};
        if (type === "snapshot_all_scripts") {
          await bridge.pushSnapshot(sessionId, {
            mode: "all",
            scripts: [...studioState.values()].map((script) => ({
              path: script.path,
              class: script.className,
              source: script.source,
              readChannel: "editor",
              draftAware: true
            }))
          });
          await bridge.submitResult(sessionId, { commandId: command.commandId, ok: true, result: { count: studioState.size } });
          continue;
        }

        if (type === "snapshot_script_by_path") {
          const path = Array.isArray(payload.path) ? payload.path : [];
          const key = pathKey(path);
          const script = studioState.get(key);
          const scripts = script
            ? [
                {
                  path: script.path,
                  class: script.className,
                  source: script.source,
                  readChannel: "editor",
                  draftAware: true
                }
              ]
            : [];
          await bridge.pushSnapshot(sessionId, { mode: "partial", scripts });
          await bridge.submitResult(sessionId, { commandId: command.commandId, ok: true, result: { found: scripts.length } });
          continue;
        }

        if (type === "snapshot_scripts_by_paths") {
          const pathList = Array.isArray(payload.paths) ? payload.paths : [];
          const scripts = [];
          for (const path of pathList) {
            const script = studioState.get(pathKey(path));
            if (script) {
              scripts.push({
                path: script.path,
                class: script.className,
                source: script.source,
                readChannel: "editor",
                draftAware: true
              });
            }
          }
          await bridge.pushSnapshot(sessionId, { mode: "partial", scripts });
          await bridge.submitResult(sessionId, {
            commandId: command.commandId,
            ok: true,
            result: { requested: pathList.length, found: scripts.length }
          });
          continue;
        }

        if (type === "set_script_source_if_hash") {
          const path = Array.isArray(payload.path) ? payload.path : [];
          const key = pathKey(path);
          const expectedHash = String(payload.expectedHash || "");
          const script = studioState.get(key);
          if (!script) {
            await bridge.submitResult(sessionId, {
              commandId: command.commandId,
              ok: false,
              error: { code: "not_found", message: "Script not found" }
            });
            continue;
          }
          const currentHash = sourceHash(script.source);
          if (currentHash !== expectedHash) {
            await bridge.submitResult(sessionId, {
              commandId: command.commandId,
              ok: false,
              error: { code: "hash_conflict", message: "Hash mismatch", details: { expectedHash, currentHash } }
            });
            continue;
          }
          const newSource = typeof payload.newSource === "string" ? payload.newSource : script.source;
          script.source = newSource;
          script.hash = sourceHash(newSource);
          script.updatedAt = new Date().toISOString();
          studioState.set(key, script);
          await bridge.pushSnapshot(sessionId, {
            mode: "partial",
            scripts: [
              {
                path: script.path,
                class: script.className,
                source: script.source,
                readChannel: "editor",
                draftAware: true
              }
            ]
          });
          await bridge.submitResult(sessionId, {
            commandId: command.commandId,
            ok: true,
            result: { writeChannel: "editor", draftAware: true }
          });
          continue;
        }

        if (type === "upsert_script") {
          const path = Array.isArray(payload.path) ? payload.path : [];
          const key = pathKey(path);
          const className = typeof payload.className === "string" ? payload.className : "LocalScript";
          const newSource = typeof payload.newSource === "string" ? payload.newSource : "";
          const now = new Date().toISOString();
          const script = {
            path,
            service: path[0] || "UnknownService",
            name: path[path.length - 1] || "Script",
            className,
            source: newSource,
            hash: sourceHash(newSource),
            updatedAt: now,
            draftAware: true,
            readChannel: "editor"
          };
          studioState.set(key, script);
          await bridge.pushSnapshot(sessionId, {
            mode: "partial",
            scripts: [
              {
                path: script.path,
                class: script.className,
                source: script.source,
                readChannel: "editor",
                draftAware: true
              }
            ]
          });
          await bridge.submitResult(sessionId, {
            commandId: command.commandId,
            ok: true,
            result: { writeChannel: "editor", draftAware: true }
          });
          continue;
        }

        await bridge.submitResult(sessionId, {
          commandId: command.commandId,
          ok: false,
          error: { code: "unsupported_command", message: `Unsupported ${type}` }
        });
      }
    }
  })();

  const targetPath = studioState.has(pathKey(["StarterGui", "RBXMCP_ApiSmoke_NoDelete"]))
    ? ["StarterGui", "RBXMCP_ApiSmoke_NoDelete"]
    : (allScripts[0]?.path || ["ServerScriptService", "MainScript"]);

  await callApi("rbx_health", {}, () => Promise.resolve(bridge.health()));
  await callApi("rbx_list_scripts", { limit: 10, query: "RBXMCP" }, () => bridge.listScripts(undefined, "RBXMCP", 10));
  const getScript = await callApi("rbx_get_script", { path: targetPath }, () => bridge.getScript(targetPath));
  const refreshed = await callApi("rbx_refresh_script", { path: targetPath }, () => bridge.refreshScript(targetPath));

  await callApi("rbx_search_text", { query: "print", limit: 10 }, () => bridge.searchText("print", { limit: 10 }));
  await callApi("rbx_find_symbols", { name: "hello", limit: 20 }, () => bridge.findSymbols({ name: "hello", limit: 20 }));
  await callApi("rbx_find_references", { symbol: "require", limit: 20 }, () => bridge.findReferences("require", { limit: 20 }));
  await callApi("rbx_get_context_bundle", {
    entryPaths: [targetPath],
    query: "print",
    budgetTokens: 600,
    dependencyDepth: 2
  }, () => bridge.getContextBundle({ entryPaths: [targetPath], query: "print", budgetTokens: 600, dependencyDepth: 2 }));
  await callApi("rbx_get_script_range", { path: targetPath, startLine: 1, endLine: 20 }, () => bridge.getScriptRange(targetPath, 1, 20));
  await callApi("rbx_get_dependencies", { path: targetPath, depth: 2 }, () => bridge.getDependencies(targetPath, 2));
  await callApi("rbx_get_impact", { path: targetPath, depth: 2 }, () => bridge.getImpact(targetPath, 2));
  await callApi("rbx_refresh_scripts", { paths: [targetPath] }, () => bridge.refreshScripts([targetPath]));

  const expectedHash = refreshed?.hash || getScript?.hash;
  if (typeof expectedHash === "string" && expectedHash.length > 0) {
    await callApi(
      "rbx_update_script",
      { path: targetPath, expectedHash, newSource: `print('api audit ${new Date().toISOString()}')` },
      () => bridge.updateScript(targetPath, `print('api audit ${new Date().toISOString()}')`, expectedHash)
    );
  }

  await callApi("rbx_health", {}, () => Promise.resolve(bridge.health()));

  running = false;
  await worker;
}

main().catch((error) => {
  console.error("=== FATAL ===");
  console.error(JSON.stringify({ message: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2));
  process.exit(1);
});
