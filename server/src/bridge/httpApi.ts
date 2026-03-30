import { randomUUID } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { z } from "zod/v4";
import { BridgeService } from "./bridgeService.js";
import { buildAgentSchemaDocument, buildCapabilitiesContractSummary, getAgentContractByEndpointPath, parsePublicContractPayload } from "./agentContract.js";
import { BridgeError } from "../lib/errors.js";
import { serializePublicPayload, summarizeErrorShape } from "../lib/publicContract.js";
import { resolveSourcePayload } from "../lib/sourcePayload.js";

const helloSchema = z.object({
  clientId: z.string().min(1),
  placeId: z.string().min(1),
  placeName: z.string().default("UnknownPlace"),
  pluginVersion: z.string().min(1),
  editorApiAvailable: z.boolean().optional(),
  base64Transport: z.boolean().optional(),
  logCaptureAvailable: z.boolean().optional()
});

const pollSchema = z.object({
  sessionId: z.string().min(1),
  waitMs: z.number().int().min(100).max(60_000).optional()
});

const resultSchema = z.object({
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  requestId: z.string().optional(),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional()
    })
    .optional()
});

const unknownAttributeMapSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value) && value.length === 0) {
      return {};
    }
    return value;
  },
  z.record(z.string(), z.unknown())
);

const pushSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(["all", "partial"]),
  scripts: z.array(
    z.object({
      path: z.array(z.string().min(1)).min(2),
      class: z.enum(["Script", "LocalScript", "ModuleScript"]),
      hash: z.string().optional(),
      source: z.string().optional(),
      sourceBase64: z.string().optional(),
      readChannel: z.enum(["editor", "unknown"]).optional(),
      draftAware: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      attributes: unknownAttributeMapSchema.optional()
    })
  )
});

const uiValueSchema: z.ZodTypeAny = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ type: z.literal("Color3"), r: z.number(), g: z.number(), b: z.number() }),
  z.object({ type: z.literal("UDim"), scale: z.number(), offset: z.number() }),
  z.object({
    type: z.literal("UDim2"),
    x: z.object({ type: z.literal("UDim"), scale: z.number(), offset: z.number() }),
    y: z.object({ type: z.literal("UDim"), scale: z.number(), offset: z.number() })
  }),
  z.object({ type: z.literal("Vector2"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("Vector3"), x: z.number(), y: z.number(), z: z.number() }),
  z.object({ type: z.literal("Enum"), enumType: z.string(), value: z.string() }),
  z.object({
    type: z.literal("ColorSequence"),
    keypoints: z.array(z.object({ time: z.number(), value: z.object({ type: z.literal("Color3"), r: z.number(), g: z.number(), b: z.number() }) }))
  }),
  z.object({
    type: z.literal("NumberSequence"),
    keypoints: z.array(z.object({ time: z.number(), value: z.number(), envelope: z.number().optional() }))
  }),
  z.object({ type: z.literal("Rect"), minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() })
]);

const uiPropsSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value) && value.length === 0) {
      return {};
    }
    return value;
  },
  z.record(z.string(), uiValueSchema).default({})
);

const attributeMapSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value) && value.length === 0) {
      return {};
    }
    return value;
  },
  z.record(z.string(), uiValueSchema)
);

const uiNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    path: z.array(z.string().min(1)).min(2),
    service: z.string().optional(),
    name: z.string().optional(),
    className: z.string(),
    version: z.string(),
    updatedAt: z.string().optional(),
    props: uiPropsSchema,
    tags: z.array(z.string()).optional(),
    attributes: attributeMapSchema.optional(),
    unsupportedProperties: z.array(z.string()).optional(),
    children: z.array(uiNodeSchema).default([])
  })
);

const pushUiSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  mode: z.enum(["all", "partial"]),
  roots: z.array(uiNodeSchema)
});

const pushLogsSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(
    z.object({
      id: z.string().optional(),
      time: z.string().optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      message: z.string(),
      source: z.string().optional(),
      playSessionId: z.string().optional(),
      requestId: z.string().optional(),
      commandId: z.string().optional()
    })
  )
});

const upsertScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("LocalScript"),
  source: z.string().default(""),
  placeId: z.string().min(1).optional()
});

const agentListScriptsSchema = z.object({
  service: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const readFreshnessSchema = z.object({
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});
const verbositySchema = z.enum(["minimal", "normal"]).optional();

const agentGetScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});

const agentRefreshScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2)
});

const agentUpdateScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  newSource: z.string().optional(),
  newSourceBase64: z.string().min(1).optional(),
  expectedHash: z.string().min(1),
  placeId: z.string().min(1).optional()
}).superRefine((payload, ctx) => {
  if (Object.prototype.hasOwnProperty.call(payload, "newSource") || typeof payload.newSourceBase64 === "string") {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: "Either newSource or newSourceBase64 is required",
    path: ["newSource"]
  });
});

const agentCreateScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  className: z.enum(["Script", "LocalScript", "ModuleScript"]).default("LocalScript"),
  source: z.string().optional().default(""),
  sourceBase64: z.string().min(1).optional(),
  placeId: z.string().min(1).optional()
});
const agentDeleteScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedHash: z.string().min(1),
  placeId: z.string().min(1).optional()
});
const agentMoveScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  newParentPath: z.array(z.string().min(1)).min(1),
  expectedHash: z.string().min(1),
  newName: z.string().min(1).optional(),
  placeId: z.string().min(1).optional()
});
const agentUpdateScriptMetadataSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedHash: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  addTags: z.array(z.string().min(1)).optional(),
  removeTags: z.array(z.string().min(1)).optional(),
  attributes: attributeMapSchema.optional(),
  clearAttributes: z.array(z.string().min(1)).optional(),
  placeId: z.string().min(1).optional()
});

const agentProjectSummarySchema = z.object({
  scope: z.enum(["all", "scripts", "ui"]).default("all"),
  service: z.string().optional(),
  verbosity: verbositySchema
});

const agentRelatedContextSchema = z.object({
  target: z.object({
    path: z.array(z.string().min(1)).min(2).optional(),
    symbol: z.string().min(1).optional(),
    query: z.string().min(1).optional()
  }),
  budgetTokens: z.number().int().min(400).max(6_000).optional(),
  verbosity: verbositySchema
});

const agentExplainErrorSchema = z.object({
  code: z.string().min(1),
  details: z.unknown().optional()
});

const agentFindEntrypointsSchema = z.object({
  query: z.string().optional(),
  service: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  verbosity: verbositySchema
});

const agentFindRemotesSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  verbosity: verbositySchema
});

const agentRankFilesByRelevanceSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  verbosity: verbositySchema
});

const agentGetChangedSinceSchema = z.object({
  cursorOrTimestamp: z.string().min(1),
  limit: z.number().int().min(1).max(1000).optional()
});

const agentGetSymbolContextSchema = z.object({
  symbol: z.string().min(1),
  budgetTokens: z.number().int().min(400).max(4_000).optional(),
  verbosity: verbositySchema
});

const agentSearchTextSchema = z.object({
  query: z.string().min(1),
  service: z.string().optional(),
  pathPrefix: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

const agentFindSymbolsSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(["function", "local", "table", "method", "module"]).optional(),
  service: z.string().optional(),
  pathPrefix: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const agentFindReferencesSchema = z.object({
  symbol: z.string().min(1),
  service: z.string().optional(),
  pathPrefix: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional()
});

const agentContextBundleSchema = z.object({
  entryPaths: z.array(z.array(z.string().min(1)).min(2)).min(1),
  query: z.string().optional(),
  budgetTokens: z.number().int().min(200).max(12_000).optional(),
  dependencyDepth: z.number().int().min(1).max(6).optional(),
  verbosity: verbositySchema
});

const agentScriptRangeSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});

const agentDependenciesSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  depth: z.number().int().min(1).max(8).optional()
});

const agentRefreshScriptsSchema = z.object({
  paths: z.array(z.array(z.string().min(1)).min(2)).min(1).max(200)
});
const agentGetScriptsSchema = z.object({
  paths: z.array(z.array(z.string().min(1)).min(2)).min(1).max(200),
  includeSource: z.boolean().optional(),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});

const agentListUiRootsSchema = z.object({
  service: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const agentGetUiTreeSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  depth: z.number().int().min(0).max(32).optional(),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});

const agentSearchUiSchema = z.object({
  query: z.string().min(1),
  rootPath: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

const agentGetUiSummarySchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
  verbosity: verbositySchema
});
const agentUiLayoutSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional(),
  verbosity: verbositySchema
});

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

const agentValidateOperationSchema = z.object({
  kind: z.enum(["script_delete", "script_move", "script_patch", "ui_clone", "ui_template", "ui_batch", "ui_layout"]),
  payload: z.record(z.string(), z.unknown())
});

const agentApplyScriptPatchSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedHash: z.string().min(1),
  patch: z.array(scriptPatchOpSchema).min(1),
  dryRun: z.boolean().optional(),
  placeId: z.string().min(1).optional()
});

const agentDiffScriptSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  baseHash: z.string().min(1).optional(),
  forceRefresh: z.boolean().optional(),
  maxAgeMs: z.number().int().min(0).max(3_600_000).optional()
});

const agentCloneUiSubtreeSchema = z.object({
  rootPath: z.array(z.string().min(1)).min(2),
  sourcePath: z.array(z.string().min(1)).min(2),
  newParentPath: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  newName: z.string().min(1).optional(),
  placeId: z.string().min(1).optional()
});

const agentApplyUiTemplateSchema = z.object({
  kind: z.enum(["modal", "shop_grid"]),
  rootPath: z.array(z.string().min(1)).min(2),
  targetPath: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
  placeId: z.string().min(1).optional()
});

const agentUpdateUiSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  props: z.record(z.string(), uiValueSchema).default({}),
  clearProps: z.array(z.string()).optional(),
  placeId: z.string().min(1).optional()
});
const agentUpdateUiMetadataSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  addTags: z.array(z.string().min(1)).optional(),
  removeTags: z.array(z.string().min(1)).optional(),
  attributes: attributeMapSchema.optional(),
  clearAttributes: z.array(z.string().min(1)).optional(),
  placeId: z.string().min(1).optional()
});

const agentCreateUiSchema = z.object({
  parentPath: z.array(z.string().min(1)).min(2),
  className: z.string().min(1),
  name: z.string().min(1),
  props: z.record(z.string(), uiValueSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
      attributes: attributeMapSchema.optional(),
  index: z.number().int().min(0).optional(),
  placeId: z.string().min(1).optional()
});

const agentDeleteUiSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  placeId: z.string().min(1).optional()
});

const agentMoveUiSchema = z.object({
  path: z.array(z.string().min(1)).min(2),
  newParentPath: z.array(z.string().min(1)).min(2),
  index: z.number().int().min(0).optional(),
  expectedVersion: z.string().min(1),
  placeId: z.string().min(1).optional()
});

const uiMutationOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_node"),
    parentPath: z.array(z.string().min(1)).min(2).optional(),
    parentRef: z.string().min(1).optional(),
    className: z.string().min(1),
    name: z.string().min(1),
    props: z.record(z.string(), uiValueSchema).optional(),
    tags: z.array(z.string().min(1)).optional(),
  attributes: attributeMapSchema.optional(),
    index: z.number().int().min(0).optional(),
    id: z.string().min(1).optional()
  }),
  z.object({
    op: z.literal("update_props"),
    path: z.array(z.string().min(1)).min(2).optional(),
    pathRef: z.string().min(1).optional(),
    props: z.record(z.string(), uiValueSchema).default({}),
    clearProps: z.array(z.string()).optional()
  }),
  z.object({
    op: z.literal("update_metadata"),
    path: z.array(z.string().min(1)).min(2).optional(),
    pathRef: z.string().min(1).optional(),
    addTags: z.array(z.string().min(1)).optional(),
    removeTags: z.array(z.string().min(1)).optional(),
      attributes: attributeMapSchema.optional(),
    clearAttributes: z.array(z.string().min(1)).optional()
  }),
  z.object({
    op: z.literal("delete_node"),
    path: z.array(z.string().min(1)).min(2).optional(),
    pathRef: z.string().min(1).optional()
  }),
  z.object({
    op: z.literal("move_node"),
    path: z.array(z.string().min(1)).min(2).optional(),
    pathRef: z.string().min(1).optional(),
    newParentPath: z.array(z.string().min(1)).min(2).optional(),
    newParentRef: z.string().min(1).optional(),
    index: z.number().int().min(0).optional()
  })
]);

const agentApplyUiBatchSchema = z.object({
  rootPath: z.array(z.string().min(1)).min(2),
  expectedVersion: z.string().min(1),
  operations: z.array(uiMutationOpSchema).min(1),
  placeId: z.string().min(1).optional()
});
const agentFindUiBindingsSchema = z.object({
  target: z.object({
    uiPath: z.array(z.string().min(1)).min(2).optional(),
    scriptPath: z.array(z.string().min(1)).min(2).optional(),
    query: z.string().min(1).optional()
  }),
  limit: z.number().int().min(1).max(100).optional()
});
const agentGetLogsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  minLevel: z.enum(["info", "warn", "error"]).optional(),
  requestId: z.string().optional(),
  sinceTime: z.string().optional(),
  untilTime: z.string().optional()
});
const agentRequestTraceSchema = z.object({
  requestId: z.string().min(1)
});
const agentValidatePayloadSchema = z.object({
  endpoint: z.string().min(1),
  payload: z.record(z.string(), z.unknown())
});

const INLINE_WRITE_SOURCE_MAX_BYTES = 64 * 1024;

function normalizeAgentRequestBody(req: Request): void {
  const contractMatch = getAgentContractByEndpointPath(req.path);
  if (!contractMatch || contractMatch.contract.method !== "POST") {
    return;
  }
  const normalized = contractMatch.id === "validate_payload"
    ? contractMatch.contract.requestSchema.parse(req.body ?? {})
    : parsePublicContractPayload(contractMatch.id, req.body ?? {});
  req.body = normalized;
  resLocals(req).normalizedPayload = normalized;
  resLocals(req).trace?.setPayload(serializePublicPayload(normalized));
}

function resLocals(req: Request): {
  requestId?: string;
  trace?: ReturnType<BridgeService["createTrace"]>;
  normalizedPayload?: unknown;
} {
  return req.res?.locals ?? {};
}

function buildStructuredInvalidRequest(detailsMessage: string, exampleValue: unknown) {
  const badField = detailsMessage.split(" ")[0] || "payload";
  return {
    expectedShape: "Canonical agent payload from /v1/agent/schema",
    ...summarizeErrorShape(badField, "slash-delimited string", "non-string", exampleValue),
    exampleFix: exampleValue
  };
}

function decodeScriptWriteSource(body: {
  source?: string;
  sourceBase64?: string;
  newSource?: string;
  newSourceBase64?: string;
}, mode: "create" | "update"): string {
  if (mode === "create") {
    return resolveSourcePayload(body.source, body.sourceBase64, "source", "sourceBase64");
  }
  return resolveSourcePayload(body.newSource, body.newSourceBase64, "newSource", "newSourceBase64");
}

function buildScriptWriteResponse(script: {
  path: string[];
  className: string;
  source: string;
  hash: string;
  updatedAt: string;
  draftAware: boolean;
  readChannel: string;
  tags: string[];
  attributes: Record<string, unknown>;
  reconciledAfterTimeout?: boolean;
  timedOutDuringPhase?: "plugin-exec" | "post-refresh";
}) {
  const reconciliation = script.reconciledAfterTimeout === true
    ? {
        reconciledAfterTimeout: true,
        timedOutDuringPhase: script.timedOutDuringPhase ?? "plugin-exec"
      }
    : {};
  const size = Buffer.byteLength(script.source, "utf8");
  if (size <= INLINE_WRITE_SOURCE_MAX_BYTES) {
    return {
      path: script.path,
      className: script.className,
      source: script.source,
      hash: script.hash,
      updatedAt: script.updatedAt,
      draftAware: script.draftAware,
      readChannel: script.readChannel,
      tags: script.tags,
      attributes: script.attributes,
      size,
      sourceOmitted: false,
      ...reconciliation
    };
  }
  return {
    path: script.path,
    className: script.className,
    hash: script.hash,
    updatedAt: script.updatedAt,
    draftAware: script.draftAware,
    readChannel: script.readChannel,
    tags: script.tags,
    attributes: script.attributes,
    size,
    sourceOmitted: true,
    sourceInlineMaxBytes: INLINE_WRITE_SOURCE_MAX_BYTES,
    ...reconciliation
  };
}

export function createBridgeHttpApp(bridge: BridgeService): express.Express {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.use((req, res, next) => {
    if (!req.path.startsWith("/v1/agent")) {
      next();
      return;
    }
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.locals.trace = bridge.createTrace(requestId, "http", req.path);
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const payload = body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), requestId }
        : { ok: true, data: body, requestId };
      const serialized = serializePublicPayload(payload);
      if ((payload as { ok?: boolean }).ok === false) {
        res.locals.trace?.finishError(serialized);
      } else {
        res.locals.trace?.finishOk(serialized);
      }
      return originalJson(serialized);
    }) as typeof res.json;
    if (req.method === "POST") {
      try {
        normalizeAgentRequestBody(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        next(new BridgeError("invalid_request", "Validation failed", 400, buildStructuredInvalidRequest(message, {
          path: "Service/Folder/Script"
        })));
        return;
      }
    } else {
      res.locals.trace?.setPayload({});
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json(bridge.health());
  });

  app.get("/v1/agent/capabilities", (_req, res) => {
    res.json({
      ...bridge.capabilities(),
      contract: buildCapabilitiesContractSummary()
    });
  });

  app.get("/v1/agent/schema", (_req, res) => {
    res.json(buildAgentSchemaDocument());
  });

  app.post("/v1/agent/health", (_req, res) => {
    res.json(bridge.health());
  });

  app.post("/v1/agent/list_scripts", async (req, res, next) => {
    try {
      const body = agentListScriptsSchema.parse(req.body ?? {});
      const items = await bridge.listScripts(body.service, body.query, body.limit);
      res.json({ ok: true, count: items.length, items, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_script", async (req, res, next) => {
    try {
      const body = agentGetScriptSchema.parse(req.body ?? {});
      const read = await bridge.readScript(body.path, readFreshnessSchema.parse(body));
      res.json({
        ok: true,
        path: read.script.path,
        source: read.script.source,
        hash: read.script.hash,
        updatedAt: read.script.updatedAt,
        draftAware: read.script.draftAware,
        readChannel: read.script.readChannel,
        tags: read.script.tags,
        attributes: read.script.attributes,
        fromCache: read.fromCache,
        cacheAgeMs: read.cacheAgeMs,
        refreshedBeforeRead: read.refreshedBeforeRead
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_script_metadata", async (req, res, next) => {
    try {
      const body = agentGetScriptSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getScriptMetadata(body.path, readFreshnessSchema.parse(body))) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_scripts", async (req, res, next) => {
    try {
      const body = agentGetScriptsSchema.parse(req.body ?? {});
      res.json({
        ok: true,
        ...(await bridge.getScripts(body.paths, {
          includeSource: body.includeSource,
          forceRefresh: body.forceRefresh,
          maxAgeMs: body.maxAgeMs
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/refresh_script", async (req, res, next) => {
    try {
      const body = agentRefreshScriptSchema.parse(req.body ?? {});
      const script = await bridge.refreshScript(body.path);
      res.json({
        ok: true,
        path: script.path,
        source: script.source,
        hash: script.hash,
        updatedAt: script.updatedAt,
        draftAware: script.draftAware,
        readChannel: script.readChannel,
        tags: script.tags,
        attributes: script.attributes
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/update_script", async (req, res, next) => {
    try {
      const body = agentUpdateScriptSchema.parse(req.body ?? {});
      const newSource = decodeScriptWriteSource(body, "update");
      const script = await bridge.updateScript(body.path, newSource, body.expectedHash, body.placeId, res.locals.trace);
      res.json({
        ok: true,
        ...buildScriptWriteResponse(script)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/create_script", async (req, res, next) => {
    try {
      const body = agentCreateScriptSchema.parse(req.body ?? {});
      const source = decodeScriptWriteSource(body, "create");
      const script = await bridge.createScript(body.path, body.className, source, body.placeId, resLocals(req).trace);
      res.json({
        ok: true,
        ...buildScriptWriteResponse(script)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/delete_script", async (req, res, next) => {
    try {
      const body = agentDeleteScriptSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.deleteScript(body.path, body.expectedHash, body.placeId)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/move_script", async (req, res, next) => {
    try {
      const body = agentMoveScriptSchema.parse(req.body ?? {});
      const script = await bridge.moveScript(body.path, body.newParentPath, body.expectedHash, body.newName, body.placeId);
      res.json({
        ok: true,
        ...buildScriptWriteResponse(script)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/update_script_metadata", async (req, res, next) => {
    try {
      const body = agentUpdateScriptMetadataSchema.parse(req.body ?? {});
      const script = await bridge.updateScriptMetadata(body.path, body.expectedHash, body, body.placeId, res.locals.trace);
      res.json({
        ok: true,
        path: script.path,
        hash: script.hash,
        updatedAt: script.updatedAt,
        draftAware: script.draftAware,
        readChannel: script.readChannel,
        tags: script.tags,
        attributes: script.attributes
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_project_summary", async (req, res, next) => {
    try {
      const body = agentProjectSummarySchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getProjectSummary(body.scope, body.service, body.verbosity)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_related_context", async (req, res, next) => {
    try {
      const body = agentRelatedContextSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getRelatedContext(body.target, body.budgetTokens, body.verbosity)), ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/explain_error", async (req, res, next) => {
    try {
      const body = agentExplainErrorSchema.parse(req.body ?? {});
      res.json({ ok: true, ...bridge.explainError(body.code, body.details) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/validate_payload", async (req, res, next) => {
    try {
      const body = agentValidatePayloadSchema.parse(req.body ?? {});
      const contractMatch = getAgentContractByEndpointPath(body.endpoint);
      if (!contractMatch) {
        throw new BridgeError("invalid_request", `Unknown endpoint for validation: ${body.endpoint}`, 400, {
          badField: "endpoint",
          exampleFix: { endpoint: "/v1/agent/get_script", payload: { path: "ServerScriptService/MainScript" } }
        });
      }
      const normalizedPayload = parsePublicContractPayload(contractMatch.id, body.payload);
      res.json({
        ok: true,
        valid: true,
        endpoint: body.endpoint,
        normalizedPayload,
        issues: [],
        expectedShape: z.toJSONSchema(contractMatch.contract.requestSchema),
        exampleFix: contractMatch.contract.examples[0] ?? null
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.json({
          ok: true,
          valid: false,
          issues: z.flattenError(error).fieldErrors,
          expectedShape: "See /v1/agent/schema",
          exampleFix: { endpoint: "/v1/agent/get_script", payload: { path: "ServerScriptService/MainScript" } }
        });
        return;
      }
      if (error instanceof Error) {
        res.json({
          ok: true,
          valid: false,
          issues: [error.message],
          expectedShape: "See /v1/agent/schema",
          exampleFix: { endpoint: "/v1/agent/get_script", payload: { path: "ServerScriptService/MainScript" } }
        });
        return;
      }
      next(error);
    }
  });

  app.post("/v1/agent/get_request_trace", async (req, res, next) => {
    try {
      const body = agentRequestTraceSchema.parse(req.body ?? {});
      const trace = bridge.getRequestTrace(body.requestId);
      if (!trace) {
        throw new BridgeError("not_found", `Request trace not found: ${body.requestId}`, 404, { requestId: body.requestId });
      }
      res.json({ ok: true, trace });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/validate_operation", async (req, res, next) => {
    try {
      const body = agentValidateOperationSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.validateOperation(body.kind, body.payload)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/apply_script_patch", async (req, res, next) => {
    try {
      const body = agentApplyScriptPatchSchema.parse(req.body ?? {});
      res.json({
        ok: true,
        ...(await bridge.applyScriptPatch(body.path, body.expectedHash, body.patch, body.placeId, {
          dryRun: body.dryRun,
          trace: res.locals.trace
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/diff_script", async (req, res, next) => {
    try {
      const body = agentDiffScriptSchema.parse(req.body ?? {});
      res.json({
        ok: true,
        ...(await bridge.diffScript(body.path, body.baseHash, readFreshnessSchema.parse(body)))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/find_entrypoints", async (req, res, next) => {
    try {
      const body = agentFindEntrypointsSchema.parse(req.body ?? {});
      const entrypoints = await bridge.findEntrypoints(body.query, body.service, body.limit, body.verbosity);
      res.json({ ok: true, count: entrypoints.length, entrypoints, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/find_remotes", async (req, res, next) => {
    try {
      const body = agentFindRemotesSchema.parse(req.body ?? {});
      const remotes = await bridge.findRemotes(body.query, body.limit, body.verbosity);
      res.json({ ok: true, count: remotes.length, remotes, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/find_ui_bindings", async (req, res, next) => {
    try {
      const body = agentFindUiBindingsSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.findUiBindings(body.target, body.limit)), ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/rank_files_by_relevance", async (req, res, next) => {
    try {
      const body = agentRankFilesByRelevanceSchema.parse(req.body ?? {});
      const items = await bridge.rankFilesByRelevance(body.query, body.limit, body.verbosity);
      res.json({ ok: true, count: items.length, items, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_changed_since", async (req, res, next) => {
    try {
      const body = agentGetChangedSinceSchema.parse(req.body ?? {});
      res.json({ ok: true, ...bridge.getChangedSince(body.cursorOrTimestamp, body.limit) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_symbol_context", async (req, res, next) => {
    try {
      const body = agentGetSymbolContextSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getSymbolContext(body.symbol, body.budgetTokens, body.verbosity)), ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/search_text", async (req, res, next) => {
    try {
      const body = agentSearchTextSchema.parse(req.body ?? {});
      const hits = await bridge.searchText(body.query, {
        service: body.service,
        pathPrefix: body.pathPrefix,
        limit: body.limit
      });
      res.json({ ok: true, count: hits.length, hits, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/find_symbols", async (req, res, next) => {
    try {
      const body = agentFindSymbolsSchema.parse(req.body ?? {});
      const symbols = await bridge.findSymbols({
        name: body.name,
        kind: body.kind,
        service: body.service,
        pathPrefix: body.pathPrefix,
        limit: body.limit
      });
      res.json({ ok: true, count: symbols.length, symbols, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/find_references", async (req, res, next) => {
    try {
      const body = agentFindReferencesSchema.parse(req.body ?? {});
      const references = await bridge.findReferences(body.symbol, {
        service: body.service,
        pathPrefix: body.pathPrefix,
        limit: body.limit
      });
      res.json({ ok: true, symbol: body.symbol, count: references.length, references, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_context_bundle", async (req, res, next) => {
    try {
      const body = agentContextBundleSchema.parse(req.body ?? {});
      const bundle = await bridge.getContextBundle(body);
      res.json({ ok: true, ...bundle, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_script_range", async (req, res, next) => {
    try {
      const body = agentScriptRangeSchema.parse(req.body ?? {});
      const range = await bridge.getScriptRange(body.path, body.startLine, body.endLine, readFreshnessSchema.parse(body));
      if (!range) {
        throw new BridgeError("not_found", `Script not found: ${body.path.join("/")}`, 404);
      }
      res.json({ ok: true, ...range });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_dependencies", async (req, res, next) => {
    try {
      const body = agentDependenciesSchema.parse(req.body ?? {});
      const deps = await bridge.getDependencies(body.path, body.depth ?? 1);
      if (!deps) {
        throw new BridgeError("not_found", `Script not found: ${body.path.join("/")}`, 404);
      }
      res.json({ ok: true, ...deps, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_impact", async (req, res, next) => {
    try {
      const body = agentDependenciesSchema.parse(req.body ?? {});
      const impact = await bridge.getImpact(body.path, body.depth ?? 1);
      if (!impact) {
        throw new BridgeError("not_found", `Script not found: ${body.path.join("/")}`, 404);
      }
      res.json({ ok: true, ...impact, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/refresh_scripts", async (req, res, next) => {
    try {
      const body = agentRefreshScriptsSchema.parse(req.body ?? {});
      const result = await bridge.refreshScripts(body.paths);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/list_ui_roots", async (req, res, next) => {
    try {
      const body = agentListUiRootsSchema.parse(req.body ?? {});
      const items = await bridge.listUiRoots(body.service, body.query, body.limit);
      res.json({ ok: true, count: items.length, items, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_ui_tree", async (req, res, next) => {
    try {
      const body = agentGetUiTreeSchema.parse(req.body ?? {});
      const read = await bridge.readUiTree(body.path, body.depth, readFreshnessSchema.parse(body));
      res.json({
        ok: true,
        tree: read.tree,
        version: read.tree.version,
        updatedAt: read.tree.updatedAt,
        fromCache: read.fromCache,
        cacheAgeMs: read.cacheAgeMs,
        refreshedBeforeRead: read.refreshedBeforeRead
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/search_ui", async (req, res, next) => {
    try {
      const body = agentSearchUiSchema.parse(req.body ?? {});
      const hits = await bridge.searchUi(body.query, { rootPath: body.rootPath, limit: body.limit });
      res.json({ ok: true, count: hits.length, hits, ...bridge.cacheTransparency() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_ui_summary", async (req, res, next) => {
    try {
      const body = agentGetUiSummarySchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getUiSummary(body.path, body)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_ui_layout_snapshot", async (req, res, next) => {
    try {
      const body = agentUiLayoutSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.getUiLayoutSnapshot(body.path, body)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/validate_ui_layout", async (req, res, next) => {
    try {
      const body = agentUiLayoutSchema.parse(req.body ?? {});
      res.json({ ok: true, ...(await bridge.validateUiLayout(body.path, body)) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/update_ui", async (req, res, next) => {
    try {
      const body = agentUpdateUiSchema.parse(req.body ?? {});
      const node = await bridge.updateUi(body.path, body.expectedVersion, body.props, body.clearProps ?? [], body.placeId);
      res.json({ ok: true, node, version: node.version, updatedAt: node.updatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/update_ui_metadata", async (req, res, next) => {
    try {
      const body = agentUpdateUiMetadataSchema.parse(req.body ?? {});
      const node = await bridge.updateUiMetadata(body.path, body.expectedVersion, body, body.placeId);
      res.json({ ok: true, node, version: node.version, updatedAt: node.updatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/apply_ui_batch", async (req, res, next) => {
    try {
      const body = agentApplyUiBatchSchema.parse(req.body ?? {});
      const result = await bridge.applyUiBatch(body.rootPath, body.expectedVersion, body.operations, body.placeId);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/clone_ui_subtree", async (req, res, next) => {
    try {
      const body = agentCloneUiSubtreeSchema.parse(req.body ?? {});
      res.json({
        ok: true,
        ...(await bridge.cloneUiSubtree(
          body.rootPath,
          body.sourcePath,
          body.newParentPath,
          body.expectedVersion,
          body.newName,
          body.placeId
        ))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/apply_ui_template", async (req, res, next) => {
    try {
      const body = agentApplyUiTemplateSchema.parse(req.body ?? {});
      res.json({
        ok: true,
        ...(await bridge.applyUiTemplate(
          body.kind,
          body.rootPath,
          body.targetPath,
          body.expectedVersion,
          body.options,
          body.placeId
        ))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/create_ui", async (req, res, next) => {
    try {
      const body = agentCreateUiSchema.parse(req.body ?? {});
      const node = await bridge.createUi(body.parentPath, body.className, body.name, body.props ?? {}, body.index, body.placeId, body);
      res.json({ ok: true, node, version: node.version, updatedAt: node.updatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/delete_ui", async (req, res, next) => {
    try {
      const body = agentDeleteUiSchema.parse(req.body ?? {});
      const result = await bridge.deleteUi(body.path, body.expectedVersion, body.placeId);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/move_ui", async (req, res, next) => {
    try {
      const body = agentMoveUiSchema.parse(req.body ?? {});
      const node = await bridge.moveUi(body.path, body.newParentPath, body.index, body.expectedVersion, body.placeId);
      res.json({ ok: true, node, version: node.version, updatedAt: node.updatedAt });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/agent/get_logs", async (req, res, next) => {
    try {
      const body = agentGetLogsSchema.parse(req.body ?? {});
      res.json({ ok: true, ...bridge.getLogs(body.cursor, body.limit, body.minLevel, body.requestId, body.sinceTime, body.untilTime) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/hello", async (req, res, next) => {
    try {
      const body = helloSchema.parse(req.body);
      const session = await bridge.hello(body);
      res.json({ ok: true, sessionId: session.sessionId, serverTime: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/poll", async (req, res, next) => {
    try {
      const body = pollSchema.parse(req.body);
      const commands = await bridge.poll(body.sessionId, body.waitMs);
      res.json({ ok: true, commands, serverTime: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/result", async (req, res, next) => {
    try {
      const body = resultSchema.parse(req.body);
      await bridge.submitResult(body.sessionId, body);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/push_snapshot", async (req, res, next) => {
    try {
      const body = pushSnapshotSchema.parse(req.body);
      const accepted = await bridge.pushSnapshot(body.sessionId, { mode: body.mode, scripts: body.scripts });
      res.json({ ok: true, accepted });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/push_ui_snapshot", async (req, res, next) => {
    try {
      const body = pushUiSnapshotSchema.parse(req.body);
      const accepted = await bridge.pushUiSnapshot(body.sessionId, { mode: body.mode, roots: body.roots });
      res.json({ ok: true, accepted });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/studio/push_logs", async (req, res, next) => {
    try {
      const body = pushLogsSchema.parse(req.body);
      const accepted = await bridge.pushLogs(body.sessionId, { entries: body.entries });
      res.json({ ok: true, accepted });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/admin/trigger_snapshot_all", async (_req, res, next) => {
    try {
      await bridge.triggerSnapshotAll();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/admin/upsert_script", async (req, res, next) => {
    try {
      if (!bridge.isAdminMutationsEnabled()) {
        throw new BridgeError(
          "admin_mutations_disabled",
          "Admin upsert is disabled. Set RBXMCP_ENABLE_ADMIN_MUTATIONS=true to enable.",
          403
        );
      }
      const body = upsertScriptSchema.parse(req.body ?? {});
      const script = await bridge.upsertScript(body.path, body.className, body.source, { placeId: body.placeId });
      res.json({
        ok: true,
        path: script.path,
        className: script.className,
        hash: script.hash,
        updatedAt: script.updatedAt,
        draftAware: script.draftAware,
        readChannel: script.readChannel
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: "endpoint_not_found",
        message: `Unknown endpoint: ${req.method} ${req.path}`,
        details: {
          hint: "Call GET /v1/agent/capabilities first to discover supported endpoints and payload contracts."
        }
      }
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof BridgeError) {
      const guidance = bridge.explainError(error.code, error.details);
      res.status(error.status).json({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details && typeof error.details === "object" ? error.details : {},
          expectedShape: "See /v1/agent/schema",
          badField: error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>).badField ?? null : null,
          exampleFix: error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>).exampleFix ?? null : null,
          recoveryHint: guidance.recommendedNextCall
        }
      });
      return;
    }
    if (error instanceof z.ZodError) {
      const flattened = z.flattenError(error);
      const firstField = Object.keys(flattened.fieldErrors)[0] ?? null;
      res.status(400).json({
        ok: false,
        error: {
          code: "invalid_request",
          message: "Validation failed",
          details: z.treeifyError(error),
          expectedShape: "See /v1/agent/schema",
          badField: firstField,
          exampleFix: { path: "Service/Folder/Script" },
          recoveryHint: {
            endpoint: "/v1/agent/schema",
            payloadTemplate: {}
          }
        }
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ ok: false, error: { code: "internal", message } });
  });

  return app;
}
