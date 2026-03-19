type TraceStatus = "in_progress" | "ok" | "error";

export interface RequestTracePhase {
  name: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: TraceStatus;
  details?: Record<string, unknown>;
}

export interface RequestTraceRecord {
  requestId: string;
  transport: "http" | "mcp";
  endpoint: string;
  toolName?: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: TraceStatus;
  normalizedPayload: unknown;
  phases: RequestTracePhase[];
  commandIds: Array<{ commandId: string; type: string; createdAt: string }>;
  relatedLogIds: string[];
  sessionSnapshot: Record<string, unknown> | null;
  result: unknown;
  error: unknown;
}

interface MutableRequestTraceRecord extends RequestTraceRecord {
  phases: RequestTracePhase[];
}

const TRACE_MAX_INLINE_STRING_CHARS = 4_096;
const TRACE_MAX_ARRAY_ITEMS = 50;
const TRACE_SOURCE_LIKE_KEYS = new Set([
  "source",
  "newSource",
  "sourceBase64",
  "newSourceBase64"
]);

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(startedAt: string, completedAt: string | null): number | null {
  if (!completedAt) {
    return null;
  }
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function sanitizeForTrace(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    const forceCompact = keyHint ? TRACE_SOURCE_LIKE_KEYS.has(keyHint) : false;
    if (!forceCompact && value.length <= TRACE_MAX_INLINE_STRING_CHARS) {
      return value;
    }
    return {
      type: "large_text",
      charLength: value.length,
      byteLength: Buffer.byteLength(value, "utf8"),
      preview: value.slice(0, Math.min(256, value.length))
    };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, TRACE_MAX_ARRAY_ITEMS).map((item) => sanitizeForTrace(item));
    if (value.length > TRACE_MAX_ARRAY_ITEMS) {
      items.push({
        type: "truncated_items",
        omittedCount: value.length - TRACE_MAX_ARRAY_ITEMS
      });
    }
    return items;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeForTrace(item, key);
  }
  return out;
}

export class RequestTraceHandle {
  constructor(private readonly record: MutableRequestTraceRecord) {}

  get requestId(): string {
    return this.record.requestId;
  }

  setPayload(payload: unknown): void {
    this.record.normalizedPayload = sanitizeForTrace(payload);
  }

  setSessionSnapshot(snapshot: Record<string, unknown> | null): void {
    this.record.sessionSnapshot = snapshot;
  }

  startPhase(name: string, details?: Record<string, unknown>): void {
    const current = this.record.phases[this.record.phases.length - 1];
    if (current && current.status === "in_progress") {
      this.endPhase(current.name, "ok");
    }
    this.record.phases.push({
      name,
      startedAt: nowIso(),
      completedAt: null,
      durationMs: null,
      status: "in_progress",
      details
    });
  }

  endPhase(name: string, status: Exclude<TraceStatus, "in_progress">, details?: Record<string, unknown>): void {
    for (let index = this.record.phases.length - 1; index >= 0; index -= 1) {
      const phase = this.record.phases[index];
      if (phase.name !== name || phase.status !== "in_progress") {
        continue;
      }
      const completedAt = nowIso();
      phase.completedAt = completedAt;
      phase.durationMs = durationMs(phase.startedAt, completedAt);
      phase.status = status;
      phase.details = {
        ...(phase.details ?? {}),
        ...(details ?? {})
      };
      return;
    }
  }

  noteCommand(commandId: string, type: string): void {
    this.record.commandIds.push({ commandId, type, createdAt: nowIso() });
  }

  noteLog(logId: string): void {
    if (!this.record.relatedLogIds.includes(logId)) {
      this.record.relatedLogIds.push(logId);
    }
  }

  finishOk(result: unknown): void {
    const completedAt = nowIso();
    const current = this.record.phases[this.record.phases.length - 1];
    if (current?.status === "in_progress") {
      this.endPhase(current.name, "ok");
    }
    this.record.completedAt = completedAt;
    this.record.durationMs = durationMs(this.record.startedAt, completedAt);
    this.record.status = "ok";
    this.record.result = sanitizeForTrace(result);
  }

  finishError(error: unknown): void {
    const completedAt = nowIso();
    const current = this.record.phases[this.record.phases.length - 1];
    if (current?.status === "in_progress") {
      this.endPhase(current.name, "error");
    }
    this.record.completedAt = completedAt;
    this.record.durationMs = durationMs(this.record.startedAt, completedAt);
    this.record.status = "error";
    this.record.error = sanitizeForTrace(error);
  }
}

export class RequestTraceStore {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, MutableRequestTraceRecord>();
  private readonly order: string[] = [];

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  start(requestId: string, transport: "http" | "mcp", endpoint: string, toolName?: string): RequestTraceHandle {
    const record: MutableRequestTraceRecord = {
      requestId,
      transport,
      endpoint,
      toolName,
      startedAt: nowIso(),
      completedAt: null,
      durationMs: null,
      status: "in_progress",
      normalizedPayload: null,
      phases: [],
      commandIds: [],
      relatedLogIds: [],
      sessionSnapshot: null,
      result: null,
      error: null
    };
    this.entries.set(requestId, record);
    this.order.push(requestId);
    this.trim();
    return new RequestTraceHandle(record);
  }

  get(requestId: string): RequestTraceRecord | null {
    const record = this.entries.get(requestId);
    if (!record) {
      return null;
    }
    return JSON.parse(JSON.stringify(record)) as RequestTraceRecord;
  }

  noteLog(requestId: string, logId: string): void {
    const record = this.entries.get(requestId);
    if (!record) {
      return;
    }
    if (!record.relatedLogIds.includes(logId)) {
      record.relatedLogIds.push(logId);
    }
  }

  private trim(): void {
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      if (!oldest) {
        continue;
      }
      this.entries.delete(oldest);
    }
  }
}
