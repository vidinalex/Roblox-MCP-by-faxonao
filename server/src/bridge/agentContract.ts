import { z } from "zod/v4";
import { normalizePublicPayload, PUBLIC_PATH_GOTCHA } from "../lib/publicContract.js";

const publicPathSchema = z.string().min(3).describe("Slash-delimited Roblox path");
const publicPathArraySchema = z.array(publicPathSchema).min(1);
const verbositySchema = z.enum(["minimal", "normal"]).optional();
const HEAVY_OPERATION_GOTCHA = "Do not wait longer than 30 seconds for heavy operations; use requestId with get_request_trace if still pending.";
const MODEL_WAIT_POLICY = {
  maxSyncWaitMs: 30_000,
  heavyOperations: [
    "create_script",
    "update_script",
    "apply_script_patch",
    "apply_ui_batch",
    "apply_ui_template",
    "get_project_summary"
  ],
  guidance: "For heavy operations, stop synchronous waiting after 30 seconds and inspect request traces/logs instead."
};
const freshnessSchema = {
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
};

const patchOpSchema = z.discriminatedUnion("op", [
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

const genericUnknownRecordSchema = z.record(z.string(), z.unknown());

type ContractDefinition = {
  method: "GET" | "POST";
  endpoint: string;
  toolName: string;
  requestSchema: z.ZodTypeAny;
  examples: unknown[];
  gotchas: string[];
  aliases?: Record<string, string>;
};

function contract(method: "GET" | "POST", endpoint: string, toolName: string, requestSchema: z.ZodTypeAny, examples: unknown[], gotchas: string[], aliases?: Record<string, string>): ContractDefinition {
  return { method, endpoint, toolName, requestSchema, examples, gotchas, aliases };
}

export const agentContracts = {
  health: contract("POST", "/v1/agent/health", "rbx_health", z.object({}), [{}], ["Use health for readiness checks before writes."]),
  capabilities: contract("GET", "/v1/agent/capabilities", "rbx_capabilities", z.object({}), [{}], ["Use schema for exact request shapes; capabilities is the compact discovery surface."]),
  schema: contract("GET", "/v1/agent/schema", "rbx_schema", z.object({}), [{}], ["Schema is authoritative for canonical payloads."]),
  list_scripts: contract("POST", "/v1/agent/list_scripts", "rbx_list_scripts", z.object({
    service: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }), [{ service: "ServerScriptService", limit: 20 }], ["This is a catalog call; it does not return source."]),
  get_script: contract("POST", "/v1/agent/get_script", "rbx_get_script", z.object({
    path: publicPathSchema,
    ...freshnessSchema
  }), [{ path: "ServerScriptService/MainScript", forceRefresh: true }], [PUBLIC_PATH_GOTCHA], { pathType: "string", hashField: "hash" }),
  get_script_metadata: contract("POST", "/v1/agent/get_script_metadata", "rbx_get_script_metadata", z.object({
    path: publicPathSchema,
    ...freshnessSchema
  }), [{ path: "ServerScriptService/MainScript" }], [PUBLIC_PATH_GOTCHA]),
  get_scripts: contract("POST", "/v1/agent/get_scripts", "rbx_get_scripts", z.object({
    paths: publicPathArraySchema.max(200),
    includeSource: z.boolean().optional(),
    ...freshnessSchema
  }), [{ paths: ["ServerScriptService/MainScript", "ReplicatedStorage/Utils/Greeter"], includeSource: false }], ["Returns per-item success/error entries in stable order."]),
  refresh_script: contract("POST", "/v1/agent/refresh_script", "rbx_refresh_script", z.object({
    path: publicPathSchema
  }), [{ path: "ServerScriptService/MainScript" }], [PUBLIC_PATH_GOTCHA]),
  update_script: contract("POST", "/v1/agent/update_script", "rbx_update_script", z.object({
    path: publicPathSchema,
    newSource: z.string(),
    expectedHash: z.string().min(1),
    placeId: z.string().min(1).optional()
  }), [{ path: "ServerScriptService/MainScript", newSource: "print('ok')", expectedHash: "hash" }], ["`expectedHash` must come from a fresh read.", "Large write responses may omit inline source and return metadata only.", "Timeout traces identify pre-refresh, plugin-exec, and post-refresh phases.", HEAVY_OPERATION_GOTCHA], { pathType: "string", hashField: "expectedHash", recommendedMaxSyncWaitMs: "30000" }),
  create_script: contract("POST", "/v1/agent/create_script", "rbx_create_script", z.object({
    path: publicPathSchema,
    className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("LocalScript"),
    source: z.string().default(""),
    placeId: z.string().min(1).optional()
  }), [{ path: "ReplicatedStorage/Utils/NewModule", className: "ModuleScript", source: "return {}" }], [PUBLIC_PATH_GOTCHA, "Large write responses may omit inline source and return metadata only.", "Large source payloads use a lightweight write result; request trace is the fallback if Studio is slow.", HEAVY_OPERATION_GOTCHA], { pathType: "string", recommendedMaxSyncWaitMs: "30000" }),
  delete_script: contract("POST", "/v1/agent/delete_script", "rbx_delete_script", z.object({
    path: publicPathSchema,
    expectedHash: z.string().min(1),
    placeId: z.string().min(1).optional()
  }), [{ path: "ServerScriptService/MainScript", expectedHash: "hash" }], [PUBLIC_PATH_GOTCHA]),
  move_script: contract("POST", "/v1/agent/move_script", "rbx_move_script", z.object({
    path: publicPathSchema,
    newParentPath: publicPathSchema,
    expectedHash: z.string().min(1),
    newName: z.string().min(1).optional(),
    placeId: z.string().min(1).optional()
  }), [{ path: "ServerScriptService/MainScript", newParentPath: "ReplicatedStorage/Moved", expectedHash: "hash", newName: "MainMoved" }], [PUBLIC_PATH_GOTCHA]),
  update_script_metadata: contract("POST", "/v1/agent/update_script_metadata", "rbx_update_script_metadata", z.object({
    path: publicPathSchema,
    expectedHash: z.string().min(1),
    addTags: z.array(z.string().min(1)).optional(),
    removeTags: z.array(z.string().min(1)).optional(),
    attributes: genericUnknownRecordSchema.optional(),
    clearAttributes: z.array(z.string().min(1)).optional(),
    placeId: z.string().min(1).optional()
  }), [{ path: "ServerScriptService/MainScript", expectedHash: "hash", addTags: ["AE_Library"], attributes: { BootPriority: 10 } }], [PUBLIC_PATH_GOTCHA, "Use hash lock for script metadata writes."]),
  get_project_summary: contract("POST", "/v1/agent/get_project_summary", "rbx_get_project_summary", z.object({
    scope: z.enum(["all", "scripts", "ui"]).default("all"),
    service: z.string().optional(),
    verbosity: verbositySchema
  }), [{ scope: "all", verbosity: "minimal" }], ["Use minimal verbosity for bootstrap."]),
  get_related_context: contract("POST", "/v1/agent/get_related_context", "rbx_get_related_context", z.object({
    target: z.object({
      path: publicPathSchema.optional(),
      symbol: z.string().min(1).optional(),
      query: z.string().min(1).optional()
    }),
    budgetTokens: z.number().int().min(400).max(6_000).optional(),
    verbosity: verbositySchema
  }), [{ target: { path: "ReplicatedStorage/Ui/ShopController" }, budgetTokens: 1200 }], ["target must be an object.", "Use one of target.path, target.symbol, or target.query."]),
  explain_error: contract("POST", "/v1/agent/explain_error", "rbx_explain_error", z.object({
    code: z.string().min(1),
    details: z.unknown().optional()
  }), [{ code: "hash_conflict", details: { currentHash: "newHash" } }], ["Pass the full error.details object to get context-specific guidance."]),
  validate_payload: contract("POST", "/v1/agent/validate_payload", "rbx_validate_payload", z.object({
    endpoint: z.string().min(1),
    payload: genericUnknownRecordSchema
  }), [{ endpoint: "/v1/agent/get_script", payload: { path: "ServerScriptService/MainScript" } }], ["Use this before writes when constructing payloads dynamically."]),
  validate_operation: contract("POST", "/v1/agent/validate_operation", "rbx_validate_operation", z.object({
    kind: z.enum(["script_delete", "script_move", "script_patch", "ui_clone", "ui_template", "ui_batch", "ui_layout"]),
    payload: genericUnknownRecordSchema
  }), [{ kind: "script_patch", payload: { path: "ServerScriptService/MainScript", expectedHash: "hash", patch: [] } }], ["validate_operation is semantic; validate_payload is for endpoint schema validation."]),
  apply_script_patch: contract("POST", "/v1/agent/apply_script_patch", "rbx_apply_script_patch", z.object({
    path: publicPathSchema,
    expectedHash: z.string().min(1),
    patch: z.array(patchOpSchema).min(1),
    dryRun: z.boolean().optional(),
    placeId: z.string().min(1).optional()
  }), [{
    path: "ServerScriptService/MainScript",
    expectedHash: "hash",
    patch: [{ op: "replace_text", oldText: "old", newText: "new" }],
    dryRun: true
  }], ["patch is always an array of operations.", "Use dryRun=true to preview applicability and diff.", HEAVY_OPERATION_GOTCHA], { patchType: "array<op>", hashField: "expectedHash", recommendedMaxSyncWaitMs: "30000" }),
  diff_script: contract("POST", "/v1/agent/diff_script", "rbx_diff_script", z.object({
    path: publicPathSchema,
    baseHash: z.string().min(1).optional(),
    ...freshnessSchema
  }), [{ path: "ServerScriptService/MainScript" }], [PUBLIC_PATH_GOTCHA]),
  find_entrypoints: contract("POST", "/v1/agent/find_entrypoints", "rbx_find_entrypoints", z.object({
    query: z.string().optional(),
    service: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    verbosity: verbositySchema
  }), [{ query: "Shop", verbosity: "minimal" }], ["This is heuristic ranking, not a strict symbol graph."]),
  find_remotes: contract("POST", "/v1/agent/find_remotes", "rbx_find_remotes", z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    verbosity: verbositySchema
  }), [{ query: "TradeRequest", verbosity: "minimal" }], ["search_text is lexical; remote matching is heuristic."]),
  find_ui_bindings: contract("POST", "/v1/agent/find_ui_bindings", "rbx_find_ui_bindings", z.object({
    target: z.object({
      uiPath: publicPathSchema.optional(),
      scriptPath: publicPathSchema.optional(),
      query: z.string().min(1).optional()
    }),
    limit: z.number().int().min(1).max(100).optional()
  }), [{ target: { uiPath: "StarterGui/MainGui/BuyButton" }, limit: 10 }], ["target must be an object."]),
  rank_files_by_relevance: contract("POST", "/v1/agent/rank_files_by_relevance", "rbx_rank_files_by_relevance", z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    verbosity: verbositySchema
  }), [{ query: "BuyRemote", limit: 10 }], []),
  get_changed_since: contract("POST", "/v1/agent/get_changed_since", "rbx_get_changed_since", z.object({
    cursorOrTimestamp: z.string().min(1),
    limit: z.number().int().min(1).max(1000).optional()
  }), [{ cursorOrTimestamp: "0", limit: 50 }], []),
  get_symbol_context: contract("POST", "/v1/agent/get_symbol_context", "rbx_get_symbol_context", z.object({
    symbol: z.string().min(1),
    budgetTokens: z.number().int().min(400).max(4_000).optional(),
    verbosity: verbositySchema
  }), [{ symbol: "openShop", verbosity: "minimal" }], []),
  search_text: contract("POST", "/v1/agent/search_text", "rbx_search_text", z.object({
    query: z.string().min(1),
    service: z.string().optional(),
    pathPrefix: publicPathSchema.optional(),
    limit: z.number().int().min(1).max(200).optional()
  }), [{ query: "TradeRequest", pathPrefix: "ReplicatedStorage/Remotes" }], ["search_text is lexical, not semantic."]),
  find_symbols: contract("POST", "/v1/agent/find_symbols", "rbx_find_symbols", z.object({
    name: z.string().optional(),
    kind: z.enum(["function", "local", "table", "method", "module"]).optional(),
    service: z.string().optional(),
    pathPrefix: publicPathSchema.optional(),
    limit: z.number().int().min(1).max(500).optional()
  }), [{ name: "openShop", pathPrefix: "ReplicatedStorage/Ui" }], []),
  find_references: contract("POST", "/v1/agent/find_references", "rbx_find_references", z.object({
    symbol: z.string().min(1),
    service: z.string().optional(),
    pathPrefix: publicPathSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional()
  }), [{ symbol: "Greeter", limit: 50 }], []),
  get_context_bundle: contract("POST", "/v1/agent/get_context_bundle", "rbx_get_context_bundle", z.object({
    entryPaths: publicPathArraySchema,
    query: z.string().optional(),
    budgetTokens: z.number().int().min(200).max(12_000).optional(),
    dependencyDepth: z.number().int().min(1).max(6).optional(),
    verbosity: verbositySchema
  }), [{ entryPaths: ["StarterGui/MainGui/Shop.client"], query: "BuyButton", budgetTokens: 1200 }], []),
  get_script_range: contract("POST", "/v1/agent/get_script_range", "rbx_get_script_range", z.object({
    path: publicPathSchema,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    ...freshnessSchema
  }), [{ path: "ReplicatedStorage/Utils/Greeter", startLine: 3, endLine: 8 }], [PUBLIC_PATH_GOTCHA]),
  get_dependencies: contract("POST", "/v1/agent/get_dependencies", "rbx_get_dependencies", z.object({
    path: publicPathSchema,
    depth: z.number().int().min(1).max(8).optional()
  }), [{ path: "ServerScriptService/MainScript", depth: 2 }], [PUBLIC_PATH_GOTCHA]),
  get_impact: contract("POST", "/v1/agent/get_impact", "rbx_get_impact", z.object({
    path: publicPathSchema,
    depth: z.number().int().min(1).max(8).optional()
  }), [{ path: "ReplicatedStorage/Utils/Greeter", depth: 2 }], [PUBLIC_PATH_GOTCHA]),
  refresh_scripts: contract("POST", "/v1/agent/refresh_scripts", "rbx_refresh_scripts", z.object({
    paths: publicPathArraySchema.max(200)
  }), [{ paths: ["StarterGui/UiA", "StarterGui/UiB"] }], []),
  list_ui_roots: contract("POST", "/v1/agent/list_ui_roots", "rbx_list_ui_roots", z.object({
    service: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional()
  }), [{ service: "StarterGui", limit: 20 }], []),
  get_ui_tree: contract("POST", "/v1/agent/get_ui_tree", "rbx_get_ui_tree", z.object({
    path: publicPathSchema,
    depth: z.number().int().min(0).max(32).optional(),
    ...freshnessSchema
  }), [{ path: "StarterGui/MainGui", depth: 2, forceRefresh: true }], [PUBLIC_PATH_GOTCHA]),
  search_ui: contract("POST", "/v1/agent/search_ui", "rbx_search_ui", z.object({
    query: z.string().min(1),
    rootPath: publicPathSchema.optional(),
    limit: z.number().int().min(1).max(200).optional()
  }), [{ query: "BuyButton", rootPath: "StarterGui/MainGui" }], []),
  get_ui_summary: contract("POST", "/v1/agent/get_ui_summary", "rbx_get_ui_summary", z.object({
    path: publicPathSchema,
    ...freshnessSchema,
    verbosity: verbositySchema
  }), [{ path: "StarterGui/MainGui", verbosity: "minimal" }], [PUBLIC_PATH_GOTCHA]),
  get_ui_layout_snapshot: contract("POST", "/v1/agent/get_ui_layout_snapshot", "rbx_get_ui_layout_snapshot", z.object({
    path: publicPathSchema,
    ...freshnessSchema,
    verbosity: verbositySchema
  }), [{ path: "StarterGui/MainGui" }], [PUBLIC_PATH_GOTCHA]),
  validate_ui_layout: contract("POST", "/v1/agent/validate_ui_layout", "rbx_validate_ui_layout", z.object({
    path: publicPathSchema,
    ...freshnessSchema,
    verbosity: verbositySchema
  }), [{ path: "StarterGui/MainGui", verbosity: "minimal" }], [PUBLIC_PATH_GOTCHA]),
  update_ui: contract("POST", "/v1/agent/update_ui", "rbx_update_ui", z.object({
    path: publicPathSchema,
    expectedVersion: z.string().min(1),
    props: genericUnknownRecordSchema.default({}),
    clearProps: z.array(z.string()).optional(),
    placeId: z.string().min(1).optional()
  }), [{ path: "StarterGui/MainGui/BuyButton", expectedVersion: "version", props: { Text: "Buy" } }], [PUBLIC_PATH_GOTCHA]),
  update_ui_metadata: contract("POST", "/v1/agent/update_ui_metadata", "rbx_update_ui_metadata", z.object({
    path: publicPathSchema,
    expectedVersion: z.string().min(1),
    addTags: z.array(z.string().min(1)).optional(),
    removeTags: z.array(z.string().min(1)).optional(),
    attributes: genericUnknownRecordSchema.optional(),
    clearAttributes: z.array(z.string().min(1)).optional(),
    placeId: z.string().min(1).optional()
  }), [{ path: "StarterGui/MainGui/BuyButton", expectedVersion: "version", addTags: ["Interactive"], attributes: { ScreenId: "shop" } }], [PUBLIC_PATH_GOTCHA, "Use version lock for UI metadata writes."]),
  apply_ui_batch: contract("POST", "/v1/agent/apply_ui_batch", "rbx_apply_ui_batch", z.object({
    rootPath: publicPathSchema,
    expectedVersion: z.string().min(1),
    operations: z.array(genericUnknownRecordSchema).min(1),
    placeId: z.string().min(1).optional()
  }), [{ rootPath: "StarterGui/MainGui", expectedVersion: "version", operations: [{ op: "create_node", parentPath: "StarterGui/MainGui", className: "Frame", name: "Panel" }] }], ["Operations use slash paths on public input."]),
  clone_ui_subtree: contract("POST", "/v1/agent/clone_ui_subtree", "rbx_clone_ui_subtree", z.object({
    rootPath: publicPathSchema,
    sourcePath: publicPathSchema,
    newParentPath: publicPathSchema,
    expectedVersion: z.string().min(1),
    newName: z.string().min(1).optional(),
    placeId: z.string().min(1).optional()
  }), [{ rootPath: "StarterGui/MainGui", sourcePath: "StarterGui/MainGui/Panel", newParentPath: "StarterGui/MainGui", expectedVersion: "version", newName: "PanelCopy" }], [PUBLIC_PATH_GOTCHA]),
  apply_ui_template: contract("POST", "/v1/agent/apply_ui_template", "rbx_apply_ui_template", z.object({
    kind: z.enum(["modal", "shop_grid"]),
    rootPath: publicPathSchema,
    targetPath: publicPathSchema,
    expectedVersion: z.string().min(1),
    options: genericUnknownRecordSchema,
    placeId: z.string().min(1).optional()
  }), [{ kind: "modal", rootPath: "StarterGui/MainGui", targetPath: "StarterGui/MainGui", expectedVersion: "version", options: { name: "ShopModal", title: "Shop" } }], []),
  create_ui: contract("POST", "/v1/agent/create_ui", "rbx_create_ui", z.object({
    parentPath: publicPathSchema,
    className: z.string().min(1),
    name: z.string().min(1),
    props: genericUnknownRecordSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    attributes: genericUnknownRecordSchema.optional(),
    index: z.number().int().min(0).optional(),
    placeId: z.string().min(1).optional()
  }), [{ parentPath: "StarterGui/MainGui", className: "TextButton", name: "BuyButton", props: { Text: "Buy" } }], []),
  delete_ui: contract("POST", "/v1/agent/delete_ui", "rbx_delete_ui", z.object({
    path: publicPathSchema,
    expectedVersion: z.string().min(1),
    placeId: z.string().min(1).optional()
  }), [{ path: "StarterGui/MainGui/BuyButton", expectedVersion: "version" }], [PUBLIC_PATH_GOTCHA]),
  move_ui: contract("POST", "/v1/agent/move_ui", "rbx_move_ui", z.object({
    path: publicPathSchema,
    newParentPath: publicPathSchema,
    index: z.number().int().min(0).optional(),
    expectedVersion: z.string().min(1),
    placeId: z.string().min(1).optional()
  }), [{ path: "StarterGui/MainGui/BuyButton", newParentPath: "StarterGui/MainGui/Panel", expectedVersion: "version" }], [PUBLIC_PATH_GOTCHA]),
  get_logs: contract("POST", "/v1/agent/get_logs", "rbx_get_logs", z.object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    minLevel: z.enum(["info", "warn", "error"]).optional(),
    requestId: z.string().optional(),
    sinceTime: z.string().optional(),
    untilTime: z.string().optional()
  }), [{ minLevel: "error", limit: 20 }, { requestId: "req-123", limit: 100 }], ["Use requestId filtering to correlate plugin/server logs."]),
  get_request_trace: contract("POST", "/v1/agent/get_request_trace", "rbx_get_request_trace", z.object({
    requestId: z.string().min(1)
  }), [{ requestId: "req-123" }], ["Request traces are kept in bounded in-memory storage."])
} satisfies Record<string, ContractDefinition>;

export type AgentContractId = keyof typeof agentContracts;

export function getAgentContract(id: string): ContractDefinition | null {
  return agentContracts[id as AgentContractId] ?? null;
}

export function getAgentContractByEndpointPath(endpointPath: string): { id: AgentContractId; contract: ContractDefinition } | null {
  for (const [id, contractDef] of Object.entries(agentContracts)) {
    if (contractDef.endpoint === endpointPath) {
      return { id: id as AgentContractId, contract: contractDef };
    }
  }
  return null;
}

export function parsePublicContractPayload(id: AgentContractId, payload: unknown): Record<string, unknown> {
  const contractDef = agentContracts[id];
  const parsed = contractDef.requestSchema.parse(payload ?? {});
  return normalizePublicPayload(parsed) as Record<string, unknown>;
}

const errorResponseSchema = z.object({
  ok: z.literal(false),
  requestId: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    expectedShape: z.unknown().optional(),
    badField: z.string().nullable().optional(),
    exampleFix: z.unknown().nullable().optional(),
    recoveryHint: z.unknown().nullable().optional()
  })
});

function successResponse(shape: z.ZodRawShape) {
  return z.object({
    ok: z.literal(true),
    requestId: z.string().optional(),
    ...shape
  });
}

function endpointResponse(shape: z.ZodRawShape) {
  return z.union([successResponse(shape), errorResponseSchema]);
}

const cacheTransparencyShape = {
  cacheUpdatedAt: z.string().nullable().optional(),
  cacheAgeMs: z.number().int().nullable().optional()
} satisfies z.ZodRawShape;

const listItemSchema = z.object({
  label: z.string(),
  count: z.number().int().nonnegative()
});

const scriptListItemSchema = z.object({
  path: publicPathSchema,
  service: z.string(),
  name: z.string(),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]),
  hash: z.string(),
  updatedAt: z.string(),
  draftAware: z.boolean(),
  readChannel: z.enum(["editor", "unknown"]),
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema
});

const scriptReadShape = {
  path: publicPathSchema,
  source: z.string(),
  hash: z.string(),
  updatedAt: z.string(),
  draftAware: z.boolean(),
  readChannel: z.enum(["editor", "unknown"]),
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema,
  fromCache: z.boolean().optional(),
  cacheAgeMs: z.number().int().min(0).nullable().optional(),
  refreshedBeforeRead: z.boolean().optional()
} satisfies z.ZodRawShape;

const scriptMetadataReadShape = {
  path: publicPathSchema,
  resolvedPath: publicPathSchema,
  resolvedPathSegments: z.array(z.string()),
  hash: z.string(),
  size: z.number().int().min(0),
  updatedAt: z.string(),
  draftAware: z.boolean(),
  readChannel: z.enum(["editor", "unknown"]),
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema,
  fromCache: z.boolean(),
  cacheAgeMs: z.number().int().min(0).nullable(),
  refreshedBeforeRead: z.boolean()
} satisfies z.ZodRawShape;

const scriptWriteShape = {
  path: publicPathSchema,
  className: z.enum(["Script", "LocalScript", "ModuleScript"]),
  source: z.string().optional(),
  hash: z.string(),
  updatedAt: z.string(),
  draftAware: z.boolean(),
  readChannel: z.enum(["editor", "unknown"]),
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema,
  size: z.number().int().min(0).optional(),
  sourceOmitted: z.boolean().optional(),
  sourceInlineMaxBytes: z.number().int().positive().optional()
} satisfies z.ZodRawShape;

const scriptMetadataWriteShape = {
  path: publicPathSchema,
  hash: z.string(),
  updatedAt: z.string(),
  draftAware: z.boolean(),
  readChannel: z.enum(["editor", "unknown"]),
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema
} satisfies z.ZodRawShape;

const scriptBulkItemSchema = z.union([
  z.object({
    ok: z.literal(true),
    path: publicPathSchema,
    resolvedPath: publicPathSchema,
    resolvedPathSegments: z.array(z.string()),
    source: z.string().optional(),
    hash: z.string(),
    updatedAt: z.string(),
    draftAware: z.boolean(),
    readChannel: z.enum(["editor", "unknown"]),
    tags: z.array(z.string()),
    attributes: genericUnknownRecordSchema,
    fromCache: z.boolean(),
    cacheAgeMs: z.number().int().min(0).nullable(),
    refreshedBeforeRead: z.boolean()
  }),
  z.object({
    ok: z.literal(false),
    path: z.union([publicPathSchema, z.array(z.string())]),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional()
    })
  })
]);

const diffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string())
});

const patchResultShape = {
  path: publicPathSchema,
  hash: z.string(),
  updatedAt: z.string(),
  operationsApplied: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  recommendedNextCalls: z.array(z.string()),
  previewSource: z.string().optional(),
  diff: z.object({
    summary: z.object({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative()
    }),
    hunks: z.array(diffHunkSchema)
  }).optional(),
  applicable: z.boolean().optional(),
  source: z.string().optional()
} satisfies z.ZodRawShape;

const uiNodeSchema: z.ZodTypeAny = z.lazy(() => z.object({
  path: publicPathSchema,
  service: z.string(),
  name: z.string(),
  className: z.string(),
  version: z.string(),
  updatedAt: z.string(),
  props: genericUnknownRecordSchema,
  tags: z.array(z.string()),
  attributes: genericUnknownRecordSchema,
  unsupportedProperties: z.array(z.string()),
  children: z.array(uiNodeSchema)
}));

const uiRootListItemSchema = z.object({
  path: publicPathSchema,
  service: z.string(),
  name: z.string(),
  className: z.string(),
  version: z.string(),
  updatedAt: z.string()
});

const uiTreeReadShape = {
  tree: uiNodeSchema,
  version: z.string(),
  updatedAt: z.string(),
  fromCache: z.boolean(),
  cacheAgeMs: z.number().int().min(0).nullable(),
  refreshedBeforeRead: z.boolean()
} satisfies z.ZodRawShape;

const uiNodeWriteShape = {
  node: uiNodeSchema,
  version: z.string(),
  updatedAt: z.string()
} satisfies z.ZodRawShape;

const logItemSchema = z.object({
  cursor: z.string(),
  id: z.string(),
  time: z.string(),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  source: z.string().nullable(),
  playSessionId: z.string().nullable(),
  requestId: z.string().nullable(),
  commandId: z.string().nullable()
});

const traceSchema = z.object({
  requestId: z.string(),
  transport: z.string(),
  endpoint: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  status: z.string(),
  normalizedPayload: z.unknown().optional(),
  phases: z.array(z.object({
    name: z.string(),
    status: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().int().nullable().optional(),
    details: z.unknown().optional()
  })),
  commandIds: z.array(z.object({
    commandId: z.string(),
    type: z.string(),
    createdAt: z.string().optional()
  })),
  relatedLogIds: z.array(z.string()),
  sessionSnapshot: z.object({
    sessionId: z.string().nullable().optional(),
    placeId: z.string().nullable().optional(),
    placeName: z.string().nullable().optional(),
    pluginVersion: z.string().nullable().optional(),
    studioOnline: z.boolean().optional()
  }).optional(),
  result: z.unknown().nullable().optional(),
  error: z.unknown().nullable().optional()
});

const issueSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional()
}).catchall(z.unknown());

const projectSummaryResponseShape = {
  placeId: z.string().nullable(),
  placeName: z.string().nullable(),
  scope: z.enum(["all", "scripts", "ui"]),
  scripts: z.object({
    totalScripts: z.number().int().nonnegative(),
    moduleCount: z.number().int().nonnegative(),
    classCounts: z.array(listItemSchema),
    services: z.array(listItemSchema),
    likelyEntrypoints: z.array(z.object({ path: publicPathSchema, reason: z.string() })),
    hotSpots: z.array(z.object({ path: publicPathSchema, reason: z.string() }))
  }).nullable(),
  ui: z.object({
    rootCount: z.number().int().nonnegative(),
    topRoots: z.array(z.object({ path: publicPathSchema, className: z.string(), version: z.string() })),
    serviceCounts: z.array(listItemSchema),
    interactiveCount: z.number().int().nonnegative(),
    textNodeCount: z.number().int().nonnegative()
  }).nullable(),
  highlights: z.array(z.string()),
  recommendedNextCalls: z.array(z.string()),
  cacheUpdatedAt: z.string().nullable(),
  cacheAgeMs: z.number().int().nullable()
} satisfies z.ZodRawShape;

const healthResponseShape = {
  startupAt: z.string(),
  now: z.string(),
  projectAlias: z.string().nullable(),
  mode: z.string(),
  bridge: z.object({
    host: z.string(),
    port: z.number().int(),
    baseUrl: z.string()
  }),
  expectedPlaceId: z.string().nullable().optional(),
  studioOnline: z.boolean(),
  scriptReadOk: z.boolean(),
  scriptWriteOk: z.boolean(),
  uiWriteOk: z.boolean(),
  logCaptureFresh: z.boolean(),
  draftMode: z.string().nullable().optional(),
  session: z.object({
    sessionId: z.string(),
    clientId: z.string(),
    placeId: z.string(),
    placeName: z.string(),
    pluginVersion: z.string(),
    connectedAt: z.string(),
    lastSeenAt: z.string(),
    lastPollAt: z.string(),
    stale: z.boolean(),
    staleAgeMs: z.number().int()
  }).nullable().optional(),
  draft: z.object({
    writeMode: z.string(),
    editorApiAvailable: z.boolean(),
    base64Transport: z.boolean(),
    lastReadChannel: z.string().nullable().optional(),
    lastWriteChannel: z.string().nullable().optional()
  }).optional(),
  uiSupported: z.boolean().optional(),
  logCaptureAvailable: z.boolean().optional(),
  logBufferSize: z.number().int().nonnegative().optional(),
  lastLogAt: z.string().nullable().optional(),
  commandTimeoutsMs: genericUnknownRecordSchema.optional(),
  cache: z.object({
    placeId: z.string(),
    placeName: z.string(),
    updatedAt: z.string(),
    writeMode: z.string(),
    scriptCount: z.number().int().nonnegative(),
    uiRootCount: z.number().int().nonnegative(),
    ageMs: z.number().int().nonnegative(),
    lastReadChannel: z.string().nullable().optional(),
    lastWriteChannel: z.string().nullable().optional(),
    indexVersion: z.number().int().nullable().optional(),
    indexUpdatedAt: z.string().nullable().optional(),
    uiIndexVersion: z.number().int().nullable().optional(),
    uiIndexUpdatedAt: z.string().nullable().optional()
  }).nullable().optional(),
  index: z.object({
    scriptCount: z.number().int().nonnegative(),
    uiRootCount: z.number().int().nonnegative()
  }).optional(),
  admin: z.object({
    upsertEnabled: z.boolean()
  }).optional()
} satisfies z.ZodRawShape;

const capabilitiesResponseShape = {
  projectAlias: z.string().nullable(),
  mode: z.string(),
  bridge: z.object({
    host: z.string(),
    port: z.number().int(),
    baseUrl: z.string()
  }),
  activeProject: z.object({
    placeId: z.string().nullable(),
    placeName: z.string().nullable(),
    studioOnline: z.boolean()
  }),
  readiness: z.object({
    scriptReadOk: z.boolean(),
    scriptWriteOk: z.boolean(),
    uiWriteOk: z.boolean(),
    logCaptureFresh: z.boolean(),
    draftMode: z.string().nullable()
  }),
  writePolicy: z.object({
    mode: z.string(),
    createOnly: z.boolean(),
    adminUpsertEnabled: z.boolean()
  }),
  defaults: z.object({
    read: z.object({
      forceRefresh: z.boolean(),
      maxAgeMs: z.number().int()
    })
  }),
  preferredBootstrapParams: z.object({
    verbosity: z.string()
  }),
  ui: z.object({
    supportedRoots: z.array(z.string()),
    createPolicy: z.string(),
    preferredMutationMode: z.string(),
    mutationPolicy: z.string(),
    propertyCodecTypes: z.array(z.string()),
    commonErrors: z.array(z.string()),
    layoutDiagnosticsSupported: z.string()
  }),
  bindings: z.object({ mode: z.string() }),
  remoteGraph: z.object({ mode: z.string() }),
  logs: z.object({
    cursorSupport: z.boolean(),
    levels: z.array(z.string()),
    retention: z.number().int()
  }),
  preferredBootstrapCalls: z.array(z.string()),
  bootstrapWorkflow: z.array(z.string()),
  recommendedNextStepByError: genericUnknownRecordSchema,
  modelWaitPolicy: z.object({
    maxSyncWaitMs: z.number().int(),
    heavyOperations: z.array(z.string()),
    guidance: z.string()
  }),
  gotchas: z.array(z.string()),
  operations: z.object({
    tools: z.array(z.string()),
    agentHttp: z.array(z.string())
  }),
  contracts: genericUnknownRecordSchema,
  contract: z.object({
    schemaUrl: z.string(),
    aliases: genericUnknownRecordSchema,
    modelWaitPolicy: z.object({
      maxSyncWaitMs: z.number().int(),
      heavyOperations: z.array(z.string()),
      guidance: z.string()
    }),
    contracts: genericUnknownRecordSchema
  })
} satisfies z.ZodRawShape;

const schemaDocumentResponseShape = {
  version: z.number().int(),
  aliases: genericUnknownRecordSchema,
  modelWaitPolicy: z.object({
    maxSyncWaitMs: z.number().int(),
    heavyOperations: z.array(z.string()),
    guidance: z.string()
  }),
  endpoints: z.array(z.object({
    id: z.string(),
    method: z.string(),
    endpoint: z.string(),
    toolName: z.string(),
    requestSchema: z.unknown(),
    responseSchema: z.unknown(),
    examples: z.array(z.unknown()),
    gotchas: z.array(z.string()),
    aliases: genericUnknownRecordSchema
  }))
} satisfies z.ZodRawShape;

export const agentResponseSchemas: Record<AgentContractId, z.ZodTypeAny> = {
  health: endpointResponse(healthResponseShape),
  capabilities: endpointResponse(capabilitiesResponseShape),
  schema: endpointResponse(schemaDocumentResponseShape),
  list_scripts: endpointResponse({ count: z.number().int().nonnegative(), items: z.array(scriptListItemSchema), ...cacheTransparencyShape }),
  get_script: endpointResponse(scriptReadShape),
  get_script_metadata: endpointResponse(scriptMetadataReadShape),
  get_scripts: endpointResponse({ items: z.array(scriptBulkItemSchema) }),
  refresh_script: endpointResponse(scriptReadShape),
  update_script: endpointResponse(scriptWriteShape),
  create_script: endpointResponse(scriptWriteShape),
  delete_script: endpointResponse({
    deletedPath: publicPathSchema,
    deletedHash: z.string(),
    recommendedNextCalls: z.array(z.string())
  }),
  move_script: endpointResponse(scriptWriteShape),
  update_script_metadata: endpointResponse(scriptMetadataWriteShape),
  get_project_summary: endpointResponse(projectSummaryResponseShape),
  get_related_context: endpointResponse({
    target: z.object({
      kind: z.string(),
      value: z.union([publicPathSchema, z.string(), z.array(z.string())]),
      resolvedPath: z.union([publicPathSchema, z.array(z.string())]).optional()
    }),
    chunks: z.array(genericUnknownRecordSchema),
    relatedScripts: z.array(z.object({ path: publicPathSchema, reason: z.string() })),
    relatedSymbols: z.array(genericUnknownRecordSchema),
    relatedUi: z.array(z.object({ path: publicPathSchema, reason: z.string() })),
    usedBudget: z.number().int().nonnegative(),
    truncated: z.boolean(),
    recommendedNextCalls: z.array(z.string()),
    ...cacheTransparencyShape
  }),
  explain_error: endpointResponse({
    code: z.string(),
    summary: z.string().optional(),
    why: z.string().optional(),
    expectedType: z.string().optional(),
    receivedType: z.string().optional(),
    correctedPayloadExample: z.unknown().optional(),
    minimalValidPayload: z.unknown().optional(),
    nearestRetry: z.unknown().optional(),
    recommendedNextCalls: z.array(z.string()).optional()
  }),
  validate_payload: endpointResponse({
    valid: z.boolean(),
    endpoint: z.string().optional(),
    normalizedPayload: genericUnknownRecordSchema.optional(),
    issues: z.union([z.array(z.unknown()), genericUnknownRecordSchema]),
    expectedShape: z.unknown(),
    exampleFix: z.unknown().nullable()
  }),
  validate_operation: endpointResponse({
    valid: z.boolean(),
    normalizedKind: z.string(),
    issues: z.array(issueSchema),
    recommendedNextCalls: z.array(z.string())
  }),
  apply_script_patch: endpointResponse(patchResultShape),
  diff_script: endpointResponse({
    path: publicPathSchema,
    currentHash: z.string(),
    baseHash: z.string(),
    summary: z.object({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative()
    }),
    hunks: z.array(diffHunkSchema),
    recommendedNextCalls: z.array(z.string())
  }),
  find_entrypoints: endpointResponse({ count: z.number().int().nonnegative(), entrypoints: z.array(z.object({ path: publicPathSchema, reason: z.string() })), ...cacheTransparencyShape }),
  find_remotes: endpointResponse({ count: z.number().int().nonnegative(), remotes: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  find_ui_bindings: endpointResponse({ bindings: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  rank_files_by_relevance: endpointResponse({ count: z.number().int().nonnegative(), items: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  get_changed_since: endpointResponse({ cursorOrTimestamp: z.string().optional(), nextCursor: z.string().nullable().optional(), items: z.array(genericUnknownRecordSchema), count: z.number().int().nonnegative().optional() }),
  get_symbol_context: endpointResponse({ symbol: z.string(), definition: genericUnknownRecordSchema.nullable().optional(), references: z.array(genericUnknownRecordSchema), relatedScripts: z.array(genericUnknownRecordSchema), chunks: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  search_text: endpointResponse({ count: z.number().int().nonnegative(), hits: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  find_symbols: endpointResponse({ count: z.number().int().nonnegative(), symbols: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  find_references: endpointResponse({ symbol: z.string(), count: z.number().int().nonnegative(), references: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  get_context_bundle: endpointResponse({ entryPaths: z.array(publicPathSchema).optional(), query: z.string().optional(), chunks: z.array(genericUnknownRecordSchema), usedBudget: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(), relatedScripts: z.array(genericUnknownRecordSchema).optional(), relatedSymbols: z.array(genericUnknownRecordSchema).optional(), ...cacheTransparencyShape }),
  get_script_range: endpointResponse({ path: publicPathSchema, startLine: z.number().int(), endLine: z.number().int(), content: z.string(), fromCache: z.boolean(), cacheAgeMs: z.number().int().nullable(), refreshedBeforeRead: z.boolean() }),
  get_dependencies: endpointResponse({ path: publicPathSchema, nodes: z.array(genericUnknownRecordSchema), edges: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  get_impact: endpointResponse({ path: publicPathSchema, impactedNodes: z.array(genericUnknownRecordSchema), edges: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  refresh_scripts: endpointResponse({ refreshed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), errors: z.array(genericUnknownRecordSchema), items: z.array(z.object(scriptReadShape)) }),
  list_ui_roots: endpointResponse({ count: z.number().int().nonnegative(), items: z.array(uiRootListItemSchema), ...cacheTransparencyShape }),
  get_ui_tree: endpointResponse(uiTreeReadShape),
  search_ui: endpointResponse({ count: z.number().int().nonnegative(), hits: z.array(genericUnknownRecordSchema), ...cacheTransparencyShape }),
  get_ui_summary: endpointResponse({
    path: publicPathSchema,
    version: z.string().optional(),
    updatedAt: z.string().optional(),
    nodeCount: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    classHistogram: z.array(listItemSchema),
    interactiveNodes: z.array(genericUnknownRecordSchema),
    textNodes: z.array(genericUnknownRecordSchema),
    layoutPrimitives: z.array(genericUnknownRecordSchema),
    bindingHints: z.array(genericUnknownRecordSchema),
    fromCache: z.boolean(),
    cacheAgeMs: z.number().int().nullable(),
    refreshedBeforeRead: z.boolean()
  }),
  get_ui_layout_snapshot: endpointResponse({
    root: genericUnknownRecordSchema.optional(),
    rootClassName: z.string().optional(),
    screenSpace: z.boolean().optional(),
    partialGeometryOnly: z.boolean().optional(),
    fromCache: z.boolean(),
    cacheAgeMs: z.number().int().nullable(),
    refreshedBeforeRead: z.boolean()
  }),
  validate_ui_layout: endpointResponse({
    path: publicPathSchema,
    issues: z.array(genericUnknownRecordSchema),
    summary: genericUnknownRecordSchema,
    partialGeometryOnly: z.boolean(),
    fromCache: z.boolean(),
    cacheAgeMs: z.number().int().nullable(),
    refreshedBeforeRead: z.boolean()
  }),
  update_ui: endpointResponse(uiNodeWriteShape),
  update_ui_metadata: endpointResponse(uiNodeWriteShape),
  apply_ui_batch: endpointResponse({
    root: uiNodeSchema,
    version: z.string(),
    updatedAt: z.string(),
    appliedCount: z.number().int().nonnegative(),
    operations: z.array(genericUnknownRecordSchema),
    resolvedRefs: z.array(genericUnknownRecordSchema)
  }),
  clone_ui_subtree: endpointResponse({
    root: uiNodeSchema,
    version: z.string(),
    updatedAt: z.string(),
    appliedCount: z.number().int().nonnegative(),
    operations: z.array(genericUnknownRecordSchema),
    resolvedRefs: z.array(genericUnknownRecordSchema),
    clonedPath: publicPathSchema,
    clonedNode: uiNodeSchema.nullable()
  }),
  apply_ui_template: endpointResponse({
    root: uiNodeSchema,
    version: z.string(),
    updatedAt: z.string(),
    appliedCount: z.number().int().nonnegative(),
    operations: z.array(genericUnknownRecordSchema),
    resolvedRefs: z.array(genericUnknownRecordSchema),
    kind: z.string(),
    recommendedNextCalls: z.array(z.string())
  }),
  create_ui: endpointResponse(uiNodeWriteShape),
  delete_ui: endpointResponse({
    deletedPath: publicPathSchema,
    parentPath: publicPathSchema.nullable(),
    parentVersion: z.string().nullable()
  }),
  move_ui: endpointResponse(uiNodeWriteShape),
  get_logs: endpointResponse({
    items: z.array(logItemSchema),
    nextCursor: z.string().nullable().optional(),
    logBufferSize: z.number().int().nonnegative(),
    lastLogAt: z.string().nullable(),
    lastCapturedAt: z.string().nullable(),
    logsStale: z.boolean()
  }),
  get_request_trace: endpointResponse({
    trace: traceSchema
  })
};

export function buildAgentSchemaDocument() {
  const aliases = {
    pathType: "string",
    patchType: "array<op>",
    hashField: "expectedHash",
    recommendedMaxSyncWaitMs: "30000"
  };
  const endpoints = Object.entries(agentContracts).map(([id, contractDef]) => ({
    id,
    method: contractDef.method,
    endpoint: contractDef.endpoint,
    toolName: contractDef.toolName,
    requestSchema: z.toJSONSchema(contractDef.requestSchema),
    responseSchema: z.toJSONSchema(agentResponseSchemas[id as AgentContractId]),
    examples: contractDef.examples,
    gotchas: contractDef.gotchas,
    aliases: {
      ...aliases,
      ...(contractDef.aliases ?? {})
    }
  }));
  return {
    ok: true,
    version: 1,
    aliases,
    modelWaitPolicy: MODEL_WAIT_POLICY,
    endpoints
  };
}

export function buildCapabilitiesContractSummary() {
  const aliases = {
    pathType: "string",
    patchType: "array<op>",
    hashField: "expectedHash",
    recommendedMaxSyncWaitMs: "30000"
  };
  const contracts: Record<string, unknown> = {};
  for (const [id, contractDef] of Object.entries(agentContracts)) {
    contracts[id] = {
      endpoint: contractDef.endpoint,
      method: contractDef.method,
      examples: contractDef.examples.slice(0, 2),
      gotchas: contractDef.gotchas,
      aliases: {
        ...aliases,
        ...(contractDef.aliases ?? {})
      }
    };
  }
  return {
    schemaUrl: "/v1/agent/schema",
    aliases,
    modelWaitPolicy: MODEL_WAIT_POLICY,
    contracts
  };
}
