import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { buildAgentSchemaDocument, getAgentContractByEndpointPath, parsePublicContractPayload } from "../bridge/agentContract.js";
import { BridgeService } from "../bridge/bridgeService.js";
import { BridgeError } from "../lib/errors.js";
import { serializePublicPayload } from "../lib/publicContract.js";
import { resolveSourcePayload } from "../lib/sourcePayload.js";
import { ContentLengthStdioTransport } from "./contentLengthStdioTransport.js";

function textResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

function buildScriptWriteResult(script: {
  path: string[];
  className: string;
  hash: string;
  updatedAt: string;
  draftAware: boolean;
  readChannel: string;
  tags: string[];
  attributes: Record<string, unknown>;
  reconciledAfterTimeout?: boolean;
  timedOutDuringPhase?: "plugin-exec" | "post-refresh";
}) {
  return {
    path: script.path,
    className: script.className,
    hash: script.hash,
    updatedAt: script.updatedAt,
    draftAware: script.draftAware,
    readChannel: script.readChannel,
    tags: script.tags,
    attributes: script.attributes,
    ...(script.reconciledAfterTimeout === true
      ? {
          reconciledAfterTimeout: true,
          timedOutDuringPhase: script.timedOutDuringPhase ?? "plugin-exec"
        }
      : {})
  };
}

async function runTool(
  bridge: BridgeService,
  endpoint: string,
  toolName: string,
  payload: Record<string, unknown>,
  execute: (normalizedPayload: Record<string, unknown>, trace: ReturnType<BridgeService["createTrace"]>) => Promise<unknown>
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const requestId = randomUUID();
  const trace = bridge.createTrace(requestId, "mcp", endpoint, toolName);
  try {
    trace.setPayload(serializePublicPayload(payload));
    const normalized = parsePublicContractPayload(getAgentContractByEndpointPath(endpoint)!.id, payload);
    trace.setPayload(serializePublicPayload(normalized));
    const result = await execute(normalized, trace);
    const body = serializePublicPayload({ requestId, ...((result as Record<string, unknown>) ?? {}), ok: true });
    trace.finishOk(body);
    return textResult(body);
  } catch (error) {
    const body = serializePublicPayload({
      ok: false,
      requestId,
      error: error instanceof BridgeError
        ? {
            code: error.code,
            message: error.message,
            details: error.details ?? null
          }
        : {
            code: "internal",
            message: error instanceof Error ? error.message : String(error)
          }
    });
    trace.finishError(body);
    return textResult(body);
  }
}

const scriptPatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace_range"),
    startLine: z.number().int().min(1),
    startCol: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endCol: z.number().int().min(1),
    text: z.string()
  }),
  z.object({
    op: z.literal("replace_text"),
    oldText: z.string().min(1),
    newText: z.string(),
    occurrence: z.number().int().min(1).optional()
  }),
  z.object({
    op: z.literal("insert_after_line"),
    line: z.number().int().min(1),
    text: z.string()
  }),
  z.object({
    op: z.literal("delete_range"),
    startLine: z.number().int().min(1),
    startCol: z.number().int().min(1),
    endLine: z.number().int().min(1),
    endCol: z.number().int().min(1)
  })
]);

export function createMcpServer(bridge: BridgeService): McpServer {
  const server = new McpServer({
    name: "roblox-studio-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "rbx_schema",
    {
      description: "Return the machine-readable RBXMCP HTTP/MCP contract schema.",
      inputSchema: {}
    },
    async () => textResult({ requestId: randomUUID(), ...buildAgentSchemaDocument() })
  );

  server.registerTool(
    "rbx_list_scripts",
    {
      description: "List cached Roblox Lua scripts. If cache is empty, triggers full snapshot from Studio.",
      inputSchema: {
        service: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ service, query, limit }) => {
      const items = await bridge.listScripts(service, query, limit);
      return textResult({ count: items.length, items, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_script",
    {
      description: "Get script source by full Roblox path (path[0] must be service).",
      inputSchema: {
        path: z.string().min(3),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, forceRefresh, maxAgeMs }) =>
      runTool(bridge, "/v1/agent/get_script", "rbx_get_script", { path, forceRefresh, maxAgeMs }, async (normalized) => {
        const read = await bridge.readScript(normalized.path, { forceRefresh: normalized.forceRefresh, maxAgeMs: normalized.maxAgeMs });
        const script = read.script;
        return {
          path: script.path,
          source: script.source,
          hash: script.hash,
          updatedAt: script.updatedAt,
          draftAware: script.draftAware,
          readChannel: script.readChannel,
          tags: script.tags,
          attributes: script.attributes,
          fromCache: read.fromCache,
          cacheAgeMs: read.cacheAgeMs,
          refreshedBeforeRead: read.refreshedBeforeRead
        };
      })
  );

  server.registerTool(
    "rbx_get_script_metadata",
    {
      description: "Get lightweight metadata for one script without returning full source.",
      inputSchema: {
        path: z.string().min(3),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, forceRefresh, maxAgeMs }) =>
      runTool(bridge, "/v1/agent/get_script_metadata", "rbx_get_script_metadata", { path, forceRefresh, maxAgeMs }, async (normalized) =>
        bridge.getScriptMetadata(normalized.path, { forceRefresh: normalized.forceRefresh, maxAgeMs: normalized.maxAgeMs })
      )
  );

  server.registerTool(
    "rbx_get_scripts",
    {
      description: "Bulk-read multiple scripts with optional source inclusion.",
      inputSchema: {
        paths: z.array(z.string().min(3)).min(1).max(200),
        includeSource: z.boolean().optional(),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ paths, includeSource, forceRefresh, maxAgeMs }) =>
      runTool(bridge, "/v1/agent/get_scripts", "rbx_get_scripts", { paths, includeSource, forceRefresh, maxAgeMs }, async (normalized) =>
        bridge.getScripts(normalized.paths, {
          includeSource: normalized.includeSource,
          forceRefresh: normalized.forceRefresh,
          maxAgeMs: normalized.maxAgeMs
        })
      )
  );

  server.registerTool(
    "rbx_refresh_script",
    {
      description: "Refresh one script from Studio and update local cache.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2)
      }
    },
    async ({ path }) => {
      const script = await bridge.refreshScript(path);
      return textResult({
        path: script.path,
        hash: script.hash,
        updatedAt: script.updatedAt,
        draftAware: script.draftAware,
        readChannel: script.readChannel,
        tags: script.tags,
        attributes: script.attributes
      });
    }
  );

  server.registerTool(
    "rbx_update_script",
    {
      description:
        "Hash-locked update. Always refreshes target script before write. Rejects if expectedHash mismatches current Studio hash.",
      inputSchema: {
        path: z.string().min(3),
        newSource: z.string().optional(),
        newSourceBase64: z.string().min(1).optional(),
        expectedHash: z.string().min(1),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, newSource, newSourceBase64, expectedHash, placeId }) =>
      runTool(bridge, "/v1/agent/update_script", "rbx_update_script", { path, newSource, newSourceBase64, expectedHash, placeId }, async (normalized, trace) => {
        const source = resolveSourcePayload(normalized.newSource, normalized.newSourceBase64, "newSource", "newSourceBase64");
        const updated = await bridge.updateScript(normalized.path, source, normalized.expectedHash, normalized.placeId, trace);
        return buildScriptWriteResult(updated);
      })
  );

  server.registerTool(
    "rbx_create_script",
    {
      description: "Create script only if missing (no overwrite). Heavy writes should not be waited on for more than 30 seconds without checking request trace.",
      inputSchema: {
        path: z.string().min(3),
        className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("LocalScript"),
        source: z.string().optional(),
        sourceBase64: z.string().min(1).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, className, source, sourceBase64, placeId }) =>
      runTool(bridge, "/v1/agent/create_script", "rbx_create_script", { path, className, source, sourceBase64, placeId }, async (normalized, trace) => {
        const resolvedSource = resolveSourcePayload(normalized.source, normalized.sourceBase64, "source", "sourceBase64");
        const created = await bridge.createScript(normalized.path, normalized.className, resolvedSource, normalized.placeId, trace);
        return buildScriptWriteResult(created);
      })
  );

  server.registerTool(
    "rbx_update_script_metadata",
    {
      description: "Hash-locked script tag/attribute update without changing source.",
      inputSchema: {
        path: z.string().min(3),
        expectedHash: z.string().min(1),
        addTags: z.array(z.string().min(1)).optional(),
        removeTags: z.array(z.string().min(1)).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        clearAttributes: z.array(z.string()).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedHash, addTags, removeTags, attributes, clearAttributes, placeId }) =>
      runTool(bridge, "/v1/agent/update_script_metadata", "rbx_update_script_metadata", { path, expectedHash, addTags, removeTags, attributes, clearAttributes, placeId }, async (normalized, trace) => {
        const updated = await bridge.updateScriptMetadata(normalized.path, normalized.expectedHash, normalized, normalized.placeId, trace);
        return {
          path: updated.path,
          hash: updated.hash,
          updatedAt: updated.updatedAt,
          draftAware: updated.draftAware,
          readChannel: updated.readChannel,
          tags: updated.tags,
          attributes: updated.attributes
        };
      })
  );

  server.registerTool(
    "rbx_delete_script",
    {
      description: "Delete a script with a hash precondition.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        expectedHash: z.string().min(1),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedHash, placeId }) => textResult(await bridge.deleteScript(path, expectedHash, placeId))
  );

  server.registerTool(
    "rbx_move_script",
    {
      description: "Move or rename a script with a hash precondition.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        newParentPath: z.array(z.string().min(1)).min(1),
        expectedHash: z.string().min(1),
        newName: z.string().min(1).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, newParentPath, expectedHash, newName, placeId }) =>
      textResult(await bridge.moveScript(path, newParentPath, expectedHash, newName, placeId))
  );

  server.registerTool(
    "rbx_health",
    {
      description: "Bridge/session/cache health check.",
      inputSchema: {}
    },
    async () => textResult(bridge.health())
  );

  server.registerTool(
    "rbx_get_project_summary",
    {
      description: "Return a compact project bootstrap summary for scripts/UI.",
      inputSchema: {
        scope: z.enum(["all", "scripts", "ui"]).default("all"),
        service: z.string().optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ scope, service, verbosity }) => textResult(await bridge.getProjectSummary(scope, service, verbosity))
  );

  server.registerTool(
    "rbx_get_related_context",
    {
      description: "Return the smallest useful script/UI context around a path, symbol, or query.",
      inputSchema: {
        target: z.object({
          path: z.array(z.string().min(1)).min(2).optional(),
          symbol: z.string().optional(),
          query: z.string().optional()
        }),
        budgetTokens: z.number().int().min(400).max(6000).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ target, budgetTokens, verbosity }) => textResult({ ...(await bridge.getRelatedContext(target, budgetTokens, verbosity)), ...bridge.cacheTransparency() })
  );

  server.registerTool(
    "rbx_explain_error",
    {
      description: "Explain a bridge/API error code and suggest the next recovery call.",
      inputSchema: {
        code: z.string().min(1),
        details: z.unknown().optional()
      }
    },
    async ({ code, details }) => textResult(bridge.explainError(code, details))
  );

  server.registerTool(
    "rbx_validate_operation",
    {
      description: "Dry-run validation for high-level script/UI authoring operations.",
      inputSchema: {
        kind: z.enum(["script_delete", "script_move", "script_patch", "ui_clone", "ui_template", "ui_batch", "ui_layout"]),
        payload: z.record(z.string(), z.unknown())
      }
    },
    async ({ kind, payload }) => textResult(await bridge.validateOperation(kind, payload))
  );

  server.registerTool(
    "rbx_validate_payload",
    {
      description: "Validate a public RBXMCP endpoint payload against the machine-readable contract.",
      inputSchema: {
        endpoint: z.string().min(1),
        payload: z.record(z.string(), z.unknown())
      }
    },
    async ({ endpoint, payload }) =>
      runTool(bridge, "/v1/agent/validate_payload", "rbx_validate_payload", { endpoint, payload }, async (normalized) => {
        const match = getAgentContractByEndpointPath(String(normalized.endpoint));
        if (!match) {
          throw new BridgeError("invalid_request", `Unknown endpoint for validation: ${normalized.endpoint}`, 400);
        }
        return {
          valid: true,
          endpoint: normalized.endpoint,
          normalizedPayload: parsePublicContractPayload(match.id, normalized.payload),
          issues: [],
          exampleFix: match.contract.examples[0] ?? null
        };
      })
  );

  server.registerTool(
    "rbx_apply_script_patch",
    {
      description: "Apply structured script patch ops through the existing hash-locked update flow.",
      inputSchema: {
        path: z.string().min(3),
        expectedHash: z.string().min(1),
        patch: z.array(scriptPatchOpSchema).min(1),
        dryRun: z.boolean().optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedHash, patch, dryRun, placeId }) =>
      runTool(bridge, "/v1/agent/apply_script_patch", "rbx_apply_script_patch", { path, expectedHash, patch, dryRun, placeId }, async (normalized, trace) =>
        bridge.applyScriptPatch(normalized.path, normalized.expectedHash, normalized.patch, normalized.placeId, {
          dryRun: normalized.dryRun,
          trace
        })
      )
  );

  server.registerTool(
    "rbx_diff_script",
    {
      description: "Return compact diff hunks between current script source and a stored base version.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        baseHash: z.string().min(1).optional(),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, baseHash, forceRefresh, maxAgeMs }) =>
      textResult(await bridge.diffScript(path, baseHash, { forceRefresh, maxAgeMs }))
  );

  server.registerTool(
    "rbx_find_entrypoints",
    {
      description: "Find likely startup points, UI controllers, remote handlers, and high fan-in modules.",
      inputSchema: {
        query: z.string().optional(),
        service: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ query, service, limit, verbosity }) => {
      const entrypoints = await bridge.findEntrypoints(query, service, limit, verbosity);
      return textResult({ count: entrypoints.length, entrypoints, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_find_remotes",
    {
      description: "Find likely remote emitters and handlers from static script analysis.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ query, limit, verbosity }) => {
      const remotes = await bridge.findRemotes(query, limit, verbosity);
      return textResult({ count: remotes.length, remotes, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_find_ui_bindings",
    {
      description: "Return heuristic UI/controller binding hints for one uiPath, scriptPath, or query.",
      inputSchema: {
        target: z.object({
          uiPath: z.array(z.string().min(1)).min(2).optional(),
          scriptPath: z.array(z.string().min(1)).min(2).optional(),
          query: z.string().min(1).optional()
        }),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ target, limit }) => textResult({ ...(await bridge.findUiBindings(target, limit)), ...bridge.cacheTransparency() })
  );

  server.registerTool(
    "rbx_rank_files_by_relevance",
    {
      description: "Rank script files by combined text, symbol, dependency, UI, and remote evidence.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ query, limit, verbosity }) => {
      const items = await bridge.rankFilesByRelevance(query, limit, verbosity);
      return textResult({ count: items.length, items, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_changed_since",
    {
      description: "Return changed scripts and UI roots since a cursor or timestamp.",
      inputSchema: {
        cursorOrTimestamp: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional()
      }
    },
    async ({ cursorOrTimestamp, limit }) => textResult(bridge.getChangedSince(cursorOrTimestamp, limit))
  );

  server.registerTool(
    "rbx_get_symbol_context",
    {
      description: "Return definition, references, related scripts, and compact chunks for one symbol.",
      inputSchema: {
        symbol: z.string().min(1),
        budgetTokens: z.number().int().min(400).max(4000).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ symbol, budgetTokens, verbosity }) => textResult({ ...(await bridge.getSymbolContext(symbol, budgetTokens, verbosity)), ...bridge.cacheTransparency() })
  );

  server.registerTool(
    "rbx_search_text",
    {
      description: "Search code/path text with ranked matches.",
      inputSchema: {
        query: z.string().min(1),
        service: z.string().optional(),
        pathPrefix: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ query, service, pathPrefix, limit }) => {
      const hits = await bridge.searchText(query, { service, pathPrefix, limit });
      return textResult({ count: hits.length, hits, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_find_symbols",
    {
      description: "Find symbols (functions/locals/tables/methods/modules) in indexed scripts.",
      inputSchema: {
        name: z.string().optional(),
        kind: z.enum(["function", "local", "table", "method", "module"]).optional(),
        service: z.string().optional(),
        pathPrefix: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ name, kind, service, pathPrefix, limit }) => {
      const symbols = await bridge.findSymbols({ name, kind, service, pathPrefix, limit });
      return textResult({ count: symbols.length, symbols, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_find_references",
    {
      description: "Find references (including definitions) for symbol name.",
      inputSchema: {
        symbol: z.string().min(1),
        service: z.string().optional(),
        pathPrefix: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      }
    },
    async ({ symbol, service, pathPrefix, limit }) => {
      const references = await bridge.findReferences(symbol, { service, pathPrefix, limit });
      return textResult({ symbol, count: references.length, references, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_context_bundle",
    {
      description: "Return compact multi-file context chunks with optional query and dependency expansion.",
      inputSchema: {
        entryPaths: z.array(z.array(z.string().min(1)).min(2)).min(1),
        query: z.string().optional(),
        budgetTokens: z.number().int().min(200).max(12000).optional(),
        dependencyDepth: z.number().int().min(1).max(6).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ entryPaths, query, budgetTokens, dependencyDepth, verbosity }) => {
      const bundle = await bridge.getContextBundle({ entryPaths, query, budgetTokens, dependencyDepth, verbosity });
      return textResult({ ...bundle, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_script_range",
    {
      description: "Return exact line range from script source.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, startLine, endLine, forceRefresh, maxAgeMs }) => {
      const result = await bridge.getScriptRange(path, startLine, endLine, { forceRefresh, maxAgeMs });
      if (!result) {
        throw new BridgeError("not_found", `Script not found: ${path.join("/")}`, 404);
      }
      return textResult(result);
    }
  );

  server.registerTool(
    "rbx_get_dependencies",
    {
      description: "Return static require dependency graph for one script.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        depth: z.number().int().min(1).max(8).optional()
      }
    },
    async ({ path, depth }) => {
      const result = await bridge.getDependencies(path, depth ?? 1);
      if (!result) {
        throw new BridgeError("not_found", `Script not found: ${path.join("/")}`, 404);
      }
      return textResult(result);
    }
  );

  server.registerTool(
    "rbx_get_impact",
    {
      description: "Return reverse dependency impact graph for one script.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        depth: z.number().int().min(1).max(8).optional()
      }
    },
    async ({ path, depth }) => {
      const result = await bridge.getImpact(path, depth ?? 1);
      if (!result) {
        throw new BridgeError("not_found", `Script not found: ${path.join("/")}`, 404);
      }
      return textResult(result);
    }
  );

  server.registerTool(
    "rbx_refresh_scripts",
    {
      description: "Batch refresh scripts from Studio with fallback to per-script pull.",
      inputSchema: {
        paths: z.array(z.array(z.string().min(1)).min(2)).min(1).max(200)
      }
    },
    async ({ paths }) => {
      const result = await bridge.refreshScripts(paths);
      return textResult(result);
    }
  );

  server.registerTool(
    "rbx_list_ui_roots",
    {
      description: "List cached UI roots. If cache is empty, triggers full UI snapshot from Studio.",
      inputSchema: {
        service: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional()
      }
    },
    async ({ service, query, limit }) => {
      const items = await bridge.listUiRoots(service, query, limit);
      return textResult({ count: items.length, items, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_ui_tree",
    {
      description: "Get UI subtree by full Roblox path.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        depth: z.number().int().min(0).max(32).optional(),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, depth, forceRefresh, maxAgeMs }) => {
      const read = await bridge.readUiTree(path, depth, { forceRefresh, maxAgeMs });
      return textResult({
        tree: read.tree,
        version: read.tree.version,
        updatedAt: read.tree.updatedAt,
        fromCache: read.fromCache,
        cacheAgeMs: read.cacheAgeMs,
        refreshedBeforeRead: read.refreshedBeforeRead
      });
    }
  );

  server.registerTool(
    "rbx_search_ui",
    {
      description: "Search UI roots and descendants by path/name/class/text properties.",
      inputSchema: {
        query: z.string().min(1),
        rootPath: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ query, rootPath, limit }) => {
      const hits = await bridge.searchUi(query, { rootPath, limit });
      return textResult({ count: hits.length, hits, ...bridge.cacheTransparency() });
    }
  );

  server.registerTool(
    "rbx_get_ui_summary",
    {
      description: "Return a compact UI subtree summary instead of the full UI tree.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ path, forceRefresh, maxAgeMs, verbosity }) => textResult(await bridge.getUiSummary(path, { forceRefresh, maxAgeMs, verbosity }))
  );

  server.registerTool(
    "rbx_get_ui_layout_snapshot",
    {
      description: "Return edit-time UI geometry snapshot for one subtree.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
      }
    },
    async ({ path, forceRefresh, maxAgeMs }) => textResult(await bridge.getUiLayoutSnapshot(path, { forceRefresh, maxAgeMs }))
  );

  server.registerTool(
    "rbx_validate_ui_layout",
    {
      description: "Return machine-friendly edit-time UI layout diagnostics.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        forceRefresh: z.boolean().optional(),
        maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
        verbosity: z.enum(["minimal", "normal"]).optional()
      }
    },
    async ({ path, forceRefresh, maxAgeMs, verbosity }) => textResult(await bridge.validateUiLayout(path, { forceRefresh, maxAgeMs, verbosity }))
  );

  server.registerTool(
    "rbx_apply_ui_batch",
    {
      description: "Apply a version-locked batch of UI mutations under one root.",
      inputSchema: {
        rootPath: z.array(z.string().min(1)).min(2),
        expectedVersion: z.string().min(1),
        operations: z.array(z.object({
          op: z.string(),
          path: z.array(z.string().min(1)).min(2).optional(),
          pathRef: z.string().min(1).optional(),
          parentPath: z.array(z.string().min(1)).min(2).optional(),
          parentRef: z.string().min(1).optional(),
          newParentPath: z.array(z.string().min(1)).min(2).optional(),
          newParentRef: z.string().min(1).optional(),
          className: z.string().optional(),
          name: z.string().optional(),
          props: z.record(z.string(), z.unknown()).optional(),
          clearProps: z.array(z.string()).optional(),
          index: z.number().int().min(0).optional(),
          id: z.string().min(1).optional()
        })).min(1),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ rootPath, expectedVersion, operations, placeId }) => {
      const result = await bridge.applyUiBatch(rootPath, expectedVersion, operations, placeId);
      return textResult(result);
    }
  );

  server.registerTool(
    "rbx_clone_ui_subtree",
    {
      description: "Clone a cached UI subtree under one root using a single version-locked batch mutation.",
      inputSchema: {
        rootPath: z.array(z.string().min(1)).min(2),
        sourcePath: z.array(z.string().min(1)).min(2),
        newParentPath: z.array(z.string().min(1)).min(2),
        expectedVersion: z.string().min(1),
        newName: z.string().min(1).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ rootPath, sourcePath, newParentPath, expectedVersion, newName, placeId }) =>
      textResult(await bridge.cloneUiSubtree(rootPath, sourcePath, newParentPath, expectedVersion, newName, placeId))
  );

  server.registerTool(
    "rbx_apply_ui_template",
    {
      description: "Compile a built-in UI template into one version-locked UI batch mutation.",
      inputSchema: {
        kind: z.enum(["modal", "shop_grid"]),
        rootPath: z.array(z.string().min(1)).min(2),
        targetPath: z.array(z.string().min(1)).min(2),
        expectedVersion: z.string().min(1),
        options: z.record(z.string(), z.unknown()),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ kind, rootPath, targetPath, expectedVersion, options, placeId }) =>
      textResult(await bridge.applyUiTemplate(kind, rootPath, targetPath, expectedVersion, options, placeId))
  );

  server.registerTool(
    "rbx_update_ui",
    {
      description: "Version-locked UI property update.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        expectedVersion: z.string().min(1),
        props: z.record(z.string(), z.unknown()),
        clearProps: z.array(z.string()).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedVersion, props, clearProps, placeId }) => {
      const node = await bridge.updateUi(path, expectedVersion, props, clearProps ?? [], placeId);
      return textResult({ node, version: node.version, updatedAt: node.updatedAt });
    }
  );

  server.registerTool(
    "rbx_update_ui_metadata",
    {
      description: "Version-locked UI tag/attribute update.",
      inputSchema: {
        path: z.string().min(3),
        expectedVersion: z.string().min(1),
        addTags: z.array(z.string().min(1)).optional(),
        removeTags: z.array(z.string().min(1)).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        clearAttributes: z.array(z.string()).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedVersion, addTags, removeTags, attributes, clearAttributes, placeId }) =>
      runTool(bridge, "/v1/agent/update_ui_metadata", "rbx_update_ui_metadata", { path, expectedVersion, addTags, removeTags, attributes, clearAttributes, placeId }, async (normalized) => {
        const node = await bridge.updateUiMetadata(normalized.path, normalized.expectedVersion, normalized, normalized.placeId);
        return { node, version: node.version, updatedAt: node.updatedAt };
      })
  );

  server.registerTool(
    "rbx_create_ui",
    {
      description: "Create a UI child under parent path if it does not already exist.",
      inputSchema: {
        parentPath: z.array(z.string().min(1)).min(2),
        className: z.string().min(1),
        name: z.string().min(1),
        props: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string().min(1)).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        index: z.number().int().min(0).optional(),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ parentPath, className, name, props, tags, attributes, index, placeId }) => {
      const node = await bridge.createUi(parentPath, className, name, props ?? {}, index, placeId, { tags, attributes });
      return textResult({ node, version: node.version, updatedAt: node.updatedAt });
    }
  );

  server.registerTool(
    "rbx_delete_ui",
    {
      description: "Delete a UI node with version lock.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        expectedVersion: z.string().min(1),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, expectedVersion, placeId }) => {
      return textResult(await bridge.deleteUi(path, expectedVersion, placeId));
    }
  );

  server.registerTool(
    "rbx_move_ui",
    {
      description: "Move a UI node to a new parent/order with version lock.",
      inputSchema: {
        path: z.array(z.string().min(1)).min(2),
        newParentPath: z.array(z.string().min(1)).min(2),
        index: z.number().int().min(0).optional(),
        expectedVersion: z.string().min(1),
        placeId: z.string().min(1).optional()
      }
    },
    async ({ path, newParentPath, index, expectedVersion, placeId }) => {
      const node = await bridge.moveUi(path, newParentPath, index, expectedVersion, placeId);
      return textResult({ node, version: node.version, updatedAt: node.updatedAt });
    }
  );

  server.registerTool(
    "rbx_get_logs",
    {
      description: "Get runtime logs captured from Studio/plugin.",
      inputSchema: {
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        minLevel: z.enum(["info", "warn", "error"]).optional(),
        requestId: z.string().optional(),
        sinceTime: z.string().optional(),
        untilTime: z.string().optional()
      }
    },
    async ({ cursor, limit, minLevel, requestId, sinceTime, untilTime }) =>
      runTool(bridge, "/v1/agent/get_logs", "rbx_get_logs", { cursor, limit, minLevel, requestId, sinceTime, untilTime }, async (normalized) =>
        bridge.getLogs(
          normalized.cursor,
          normalized.limit,
          normalized.minLevel,
          typeof normalized.requestId === "string" ? normalized.requestId : undefined,
          typeof normalized.sinceTime === "string" ? normalized.sinceTime : undefined,
          typeof normalized.untilTime === "string" ? normalized.untilTime : undefined
        )
      )
  );

  server.registerTool(
    "rbx_get_request_trace",
    {
      description: "Return the stored request trace for one requestId.",
      inputSchema: {
        requestId: z.string().min(1)
      }
    },
    async ({ requestId }) =>
      runTool(bridge, "/v1/agent/get_request_trace", "rbx_get_request_trace", { requestId }, async (normalized) => {
        const trace = bridge.getRequestTrace(String(normalized.requestId));
        if (!trace) {
          throw new BridgeError("not_found", `Request trace not found: ${normalized.requestId}`, 404, { requestId: normalized.requestId });
        }
        return { trace };
      })
  );

  return server;
}

export async function connectMcpStdio(server: McpServer): Promise<void> {
  const transport = new ContentLengthStdioTransport();
  await server.connect(transport);
}
