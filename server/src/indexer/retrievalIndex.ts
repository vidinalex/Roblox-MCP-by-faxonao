import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CacheStore } from "../cache/cacheStore.js";
import { ScriptClass, ScriptSnapshot } from "../domain/types.js";
import { normalizePath, pathKey, scriptNameFromPath, serviceFromPath } from "../lib/path.js";

const INDEX_VERSION = 1;
const INDEX_FILE = "retrieval-index.v1.json";
const MAX_SEARCH_MATCHES_PER_SCRIPT = 5;
const MAX_INDEXED_SOURCE_CHARS = 64 * 1024;
const MAX_INDEX_TOKEN_CHARS = 128;
const TRUNCATED_SOURCE_MARKER = "\n-- RBXMCP: source truncated for retrieval index --\n";

export type SymbolKind = "function" | "local" | "table" | "method" | "module";

export interface TextMatch {
  line: number;
  startCol: number;
  endCol: number;
  snippet: string;
}

export interface TextSearchHit {
  path: string[];
  className: ScriptClass;
  score: number;
  matches: TextMatch[];
}

export interface SymbolHit {
  symbol: string;
  kind: SymbolKind;
  path: string[];
  line: number;
  col: number;
  container: string | null;
}

export interface ReferenceHit {
  symbol: string;
  path: string[];
  line: number;
  col: number;
  snippet: string;
  isDefinition: boolean;
}

export interface GraphNode {
  path: string[];
  className: ScriptClass;
}

export interface GraphEdge {
  from: string[];
  to: string[];
}

export interface ContextChunk {
  path: string[];
  startLine: number;
  endLine: number;
  reason: string;
  content: string;
}

export interface ProjectSummaryItem {
  label: string;
  count: number;
}

export interface ProjectPathReason {
  path: string[];
  reason: string;
}

export interface ProjectSummary {
  totalScripts: number;
  moduleCount: number;
  classCounts: ProjectSummaryItem[];
  services: ProjectSummaryItem[];
  likelyEntrypoints: ProjectPathReason[];
  hotSpots: ProjectPathReason[];
}

export type EntrypointCategory =
  | "server_bootstrap"
  | "client_bootstrap"
  | "ui_controller"
  | "remote_handler"
  | "high_fan_in_module";

export interface EntrypointHit {
  path: string[];
  className: ScriptClass;
  score: number;
  reasons: string[];
  category: EntrypointCategory;
}

export interface RemoteParticipant {
  path: string[];
  action: string;
}

export interface RemoteHit {
  name: string;
  kind: "RemoteEvent" | "RemoteFunction" | "unknown";
  inferredPath: string[] | null;
  emitters: RemoteParticipant[];
  handlers: RemoteParticipant[];
  score: number;
  snippets: string[];
  confidence: number;
  evidence: string[];
  argHints: string[];
  pairedParticipants: string[][];
  unresolvedPath: boolean;
}

interface IdentifierToken {
  value: string;
  offset: number;
}

export interface RankedFileHit {
  path: string[];
  className: ScriptClass;
  score: number;
  why: string[];
  textHits?: number;
  symbolHits?: number;
  dependencyHits?: number;
  uiHits?: number;
  remoteHits?: number;
}

interface IndexedScript extends ScriptSnapshot {
  key: string;
}

interface PersistedIndex {
  version: number;
  updatedAt: string;
  placeId: string;
  scripts: ScriptSnapshot[];
}

interface SymbolInternal extends SymbolHit {
  key: string;
}

interface ReferenceInternal extends ReferenceHit {
  key: string;
}

interface QueryFilter {
  service?: string;
  pathPrefix?: string[];
}

interface FileSummaryInternal {
  key: string;
  dependencyCount: number;
  impactCount: number;
  referenceCount: number;
  symbolCount: number;
}

interface RemoteInternal {
  name: string;
  key: string;
  inferredPath: string[] | null;
  kind: "RemoteEvent" | "RemoteFunction" | "unknown";
  emitters: Array<RemoteParticipant & { key: string; snippet: string }>;
  handlers: Array<RemoteParticipant & { key: string; snippet: string }>;
}

function tokenize(input: string): string[] {
  const matches = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  return matches ? matches.filter((part) => part.length > 0 && part.length <= MAX_INDEX_TOKEN_CHARS) : [];
}

function compactSourceForIndex(sourceInput: string): string {
  const source = String(sourceInput ?? "");
  if (source.length <= MAX_INDEXED_SOURCE_CHARS) {
    return source;
  }
  const remaining = Math.max(0, MAX_INDEXED_SOURCE_CHARS - TRUNCATED_SOURCE_MARKER.length);
  const headLength = Math.max(0, Math.floor(remaining * 0.75));
  const tailLength = Math.max(0, remaining - headLength);
  return `${source.slice(0, headLength)}${TRUNCATED_SOURCE_MARKER}${source.slice(Math.max(0, source.length - tailLength))}`;
}

function clampLimit(input: number | undefined, fallback: number, max: number): number {
  const value = Number.isFinite(input) ? Math.trunc(input as number) : fallback;
  return Math.max(1, Math.min(value, max));
}

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_\u0080-\uFFFF]/.test(char));
}

function isIdentifierContinue(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_\u0080-\uFFFF]/.test(char));
}

function readLongBracketClose(source: string, index: number): { close: string; nextIndex: number } | null {
  if (source[index] !== "[") {
    return null;
  }
  let probe = index + 1;
  while (source[probe] === "=") {
    probe += 1;
  }
  if (source[probe] !== "[") {
    return null;
  }
  const equalsCount = probe - (index + 1);
  return {
    close: `]${"=".repeat(equalsCount)}]`,
    nextIndex: probe + 1
  };
}

function collectIdentifierTokens(source: string): IdentifierToken[] {
  const tokens: IdentifierToken[] = [];
  let index = 0;
  let inComment = false;
  let inString = false;
  let quote = "";
  let longClose = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (longClose) {
        if (source.startsWith(longClose, index)) {
          const closeLength = longClose.length;
          inComment = false;
          longClose = "";
          index += closeLength;
          continue;
        }
      } else if (char === "\n") {
        inComment = false;
      }
      index += 1;
      continue;
    }
    if (inString) {
      if (longClose) {
        if (source.startsWith(longClose, index)) {
          inString = false;
          index += longClose.length;
          longClose = "";
          continue;
        }
        index += 1;
        continue;
      }
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const longBracket = readLongBracketClose(source, index + 2);
      inComment = true;
      longClose = longBracket?.close ?? "";
      index = longBracket ? longBracket.nextIndex : index + 2;
      continue;
    }
    const longBracket = readLongBracketClose(source, index);
    if (longBracket) {
      inString = true;
      longClose = longBracket.close;
      index = longBracket.nextIndex;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      inString = true;
      quote = char;
      index += 1;
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierContinue(source[index])) {
        index += 1;
      }
      tokens.push({ value: source.slice(start, index), offset: start });
      continue;
    }
    index += 1;
  }
  return tokens;
}

function cleanupRemoteExpression(expression: string): string {
  let out = String(expression ?? "").trim();
  out = out.replace(/::[A-Za-z0-9_<>,.\s|?()[\]'"-]+$/g, "");
  out = out.replace(/[)\]}>,;]+$/g, "");
  out = out.replace(/^\(+/, "");
  out = out.trim();
  while (out.endsWith(")")) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes > opens) {
      out = out.slice(0, -1).trim();
      continue;
    }
    break;
  }
  return out;
}

function looksNoisyRemoteName(name: string): boolean {
  const value = String(name ?? "");
  return !value
    || /[(){}[\]:;]/.test(value)
    || /^remote(?:event|function)?$/i.test(value)
    || /^_?remote$/i.test(value)
    || /^_?updatedevent$/i.test(value)
    || /^_?snapshotfunction$/i.test(value)
    || /^placeremote$/i.test(value);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function locateOffset(source: string, starts: number[], offset: number): { line: number; col: number; lineText: string } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const lineIndex = Math.max(0, high);
  const lineStart = starts[lineIndex];
  const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : source.length;
  const lineText = source.slice(lineStart, lineEnd);
  return {
    line: lineIndex + 1,
    col: offset - lineStart + 1,
    lineText
  };
}

function normalizePathPrefix(input: unknown): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new Error("pathPrefix must be an array");
  }
  const out = input
    .map((segment) => {
      if (typeof segment !== "string") {
        throw new Error("pathPrefix segments must be strings");
      }
      const trimmed = segment.trim();
      if (!trimmed) {
        throw new Error("pathPrefix segments must be non-empty");
      }
      return trimmed;
    })
    .filter(Boolean);
  if (out.length === 0) {
    throw new Error("pathPrefix must contain at least one segment");
  }
  return out;
}

function pathMatchesPrefix(path: string[], prefix?: string[]): boolean {
  if (!prefix || prefix.length === 0) {
    return true;
  }
  if (prefix.length > path.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function approxTokenCount(text: string): number {
  const parts = text.match(/\S+/g);
  return parts ? parts.length : 0;
}

function previewText(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function detectRemoteKind(action: string): "RemoteEvent" | "RemoteFunction" | "unknown" {
  if (["FireServer", "FireClient", "FireAllClients", "OnServerEvent", "OnClientEvent"].includes(action)) {
    return "RemoteEvent";
  }
  if (["InvokeServer", "InvokeClient", "OnServerInvoke", "OnClientInvoke"].includes(action)) {
    return "RemoteFunction";
  }
  return "unknown";
}

function categoryWeight(category: EntrypointCategory): number {
  switch (category) {
    case "server_bootstrap":
      return 10;
    case "client_bootstrap":
      return 9;
    case "ui_controller":
      return 8;
    case "remote_handler":
      return 8;
    case "high_fan_in_module":
      return 7;
    default:
      return 1;
  }
}

function parseRequireCalls(source: string): Array<{ expression: string }> {
  const out: Array<{ expression: string }> = [];
  const re = /require\s*\(\s*([^)]+?)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push({ expression: match[1].trim() });
  }
  return out;
}

function splitDotChain(input: string): string[] {
  return input
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function resolveRequirePath(expression: string, currentPath: string[]): string[] | null {
  const compact = expression.replace(/\s+/g, "");
  const scriptChain = compact.match(/^script((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/);
  if (scriptChain) {
    const chain = splitDotChain(scriptChain[1]);
    const path = [...currentPath];
    for (const segment of chain) {
      if (segment === "Parent") {
        if (path.length <= 1) {
          return null;
        }
        path.pop();
      } else {
        path.push(segment);
      }
    }
    return path;
  }

  const gameService = compact.match(/^game:GetService\(["']([A-Za-z_][A-Za-z0-9_]*)["']\)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/);
  if (gameService) {
    const chain = splitDotChain(gameService[2]);
    return [gameService[1], ...chain];
  }

  const gameDot = compact.match(/^game\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/);
  if (gameDot) {
    const rest = gameDot[2] ? splitDotChain(gameDot[2]) : [];
    return [gameDot[1], ...rest];
  }

  const absolute = compact.match(/^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/);
  if (absolute) {
    return [absolute[1], ...splitDotChain(absolute[2])];
  }

  return null;
}

export class RetrievalIndex {
  private readonly cache: CacheStore;
  private placeId: string | null = null;
  private scripts = new Map<string, IndexedScript>();
  private textPostings = new Map<string, Map<string, number>>();
  private symbolsByName = new Map<string, SymbolInternal[]>();
  private referencesByName = new Map<string, ReferenceInternal[]>();
  private dependencies = new Map<string, Set<string>>();
  private unresolvedRequires = new Map<string, string[]>();
  private impact = new Map<string, Set<string>>();
  private remoteIndex = new Map<string, RemoteInternal>();
  private fileSummaries = new Map<string, FileSummaryInternal>();

  constructor(cache: CacheStore) {
    this.cache = cache;
  }

  async bootstrap(): Promise<void> {
    const metadata = this.cache.metadata();
    if (!metadata) {
      return;
    }
    await this.switchPlace(metadata.placeId);
    if (this.scripts.size === 0 && this.cache.scriptCount() > 0) {
      await this.fullRebuildFromCache();
    }
  }

  async switchPlace(placeId: string): Promise<void> {
    if (this.placeId === placeId) {
      return;
    }
    this.placeId = placeId;
    this.clearInMemory();
    await this.loadFromDisk();
  }

  async fullRebuildFromCache(): Promise<void> {
    const all = await this.cache.listAllScriptsWithSource();
    this.rebuildFromSnapshots(all);
    await this.persist();
  }

  async upsertChangedPaths(paths: string[][]): Promise<void> {
    let changed = false;
    for (const path of paths) {
      const normalized = normalizePath(path);
      const key = pathKey(normalized);
      const snapshot = await this.cache.getScript(normalized);
      if (!snapshot) {
        if (this.scripts.has(key)) {
          this.scripts.delete(key);
          changed = true;
        }
        continue;
      }
      this.scripts.set(key, { ...snapshot, source: compactSourceForIndex(snapshot.source), key });
      changed = true;
    }
    if (changed) {
      this.rebuildSecondaryIndexes();
      await this.persist();
    }
  }

  searchText(
    queryInput: string,
    options: { service?: string; pathPrefix?: unknown; limit?: number } = {}
  ): TextSearchHit[] {
    const query = String(queryInput ?? "").trim();
    if (!query) {
      return [];
    }
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }
    const prefix = normalizePathPrefix(options.pathPrefix);
    const limit = clampLimit(options.limit, 20, 200);
    const filter: QueryFilter = { service: options.service, pathPrefix: prefix };
    const queryLower = query.toLowerCase();

    const candidateKeys = new Set<string>();
    for (const token of tokens) {
      const postings = this.textPostings.get(token);
      if (!postings) {
        continue;
      }
      for (const key of postings.keys()) {
        candidateKeys.add(key);
      }
    }

    const hits: TextSearchHit[] = [];
    for (const key of candidateKeys) {
      const script = this.scripts.get(key);
      if (!script || !this.matchesFilter(script, filter)) {
        continue;
      }

      let score = 0;
      for (const token of tokens) {
        score += this.textPostings.get(token)?.get(key) ?? 0;
      }
      const matches = this.findTextMatches(script.source, queryLower);
      if (matches.length === 0) {
        continue;
      }
      hits.push({
        path: script.path,
        className: script.className,
        score,
        matches
      });
    }

    hits.sort((a, b) => b.score - a.score || a.path.join("/").localeCompare(b.path.join("/")));
    return hits.slice(0, limit);
  }

  findSymbols(options: {
    name?: string;
    kind?: SymbolKind;
    service?: string;
    pathPrefix?: unknown;
    limit?: number;
  }): SymbolHit[] {
    const nameFilter = options.name?.trim().toLowerCase();
    const prefix = normalizePathPrefix(options.pathPrefix);
    const limit = clampLimit(options.limit, 100, 500);
    const out: SymbolHit[] = [];
    for (const symbols of this.symbolsByName.values()) {
      for (const symbol of symbols) {
        if (options.kind && symbol.kind !== options.kind) {
          continue;
        }
        if (nameFilter && !symbol.symbol.toLowerCase().includes(nameFilter)) {
          continue;
        }
        const script = this.scripts.get(symbol.key);
        if (!script || !this.matchesFilter(script, { service: options.service, pathPrefix: prefix })) {
          continue;
        }
        out.push({
          symbol: symbol.symbol,
          kind: symbol.kind,
          path: symbol.path,
          line: symbol.line,
          col: symbol.col,
          container: symbol.container
        });
      }
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.path.join("/").localeCompare(b.path.join("/")) || a.line - b.line);
    return out.slice(0, limit);
  }

  findReferences(
    symbolInput: string,
    options: { service?: string; pathPrefix?: unknown; limit?: number } = {}
  ): ReferenceHit[] {
    const symbol = symbolInput.trim();
    if (!symbol) {
      return [];
    }
    const prefix = normalizePathPrefix(options.pathPrefix);
    const references = this.referencesByName.get(symbol.toLowerCase()) ?? [];
    const limit = clampLimit(options.limit, 200, 1000);
    const out: ReferenceHit[] = [];
    for (const reference of references) {
      const script = this.scripts.get(reference.key);
      if (!script || !this.matchesFilter(script, { service: options.service, pathPrefix: prefix })) {
        continue;
      }
      out.push({
        symbol: reference.symbol,
        path: reference.path,
        line: reference.line,
        col: reference.col,
        snippet: reference.snippet,
        isDefinition: reference.isDefinition
      });
      if (out.length >= limit) {
        break;
      }
    }
    out.sort((a, b) => Number(b.isDefinition) - Number(a.isDefinition) || a.path.join("/").localeCompare(b.path.join("/")) || a.line - b.line);
    return out;
  }

  getScriptRange(pathInput: unknown, startLineInput: number, endLineInput: number): {
    path: string[];
    content: string;
    actualStartLine: number;
    actualEndLine: number;
    totalLines: number;
    hash: string;
  } | null {
    const path = normalizePath(pathInput);
    const script = this.scripts.get(pathKey(path));
    if (!script) {
      return null;
    }
    const lines = script.source.split("\n");
    const totalLines = lines.length;
    const startLine = Math.max(1, Math.min(totalLines, Math.trunc(startLineInput)));
    const endLine = Math.max(startLine, Math.min(totalLines, Math.trunc(endLineInput)));
    return {
      path: script.path,
      content: lines.slice(startLine - 1, endLine).join("\n"),
      actualStartLine: startLine,
      actualEndLine: endLine,
      totalLines,
      hash: script.hash
    };
  }

  getDependencies(pathInput: unknown, depthInput = 1): { nodes: GraphNode[]; edges: GraphEdge[]; unresolvedRequires: string[] } | null {
    const path = normalizePath(pathInput);
    const rootKey = pathKey(path);
    if (!this.scripts.has(rootKey)) {
      return null;
    }
    const depth = Math.max(1, Math.min(8, Math.trunc(depthInput)));
    const visited = new Set<string>([rootKey]);
    const queue: Array<{ key: string; level: number }> = [{ key: rootKey, level: 0 }];
    const edges: GraphEdge[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.level >= depth) {
        continue;
      }
      const targets = this.dependencies.get(current.key) ?? new Set<string>();
      for (const target of targets) {
        edges.push({
          from: this.scripts.get(current.key)!.path,
          to: this.scripts.get(target)!.path
        });
        if (!visited.has(target)) {
          visited.add(target);
          queue.push({ key: target, level: current.level + 1 });
        }
      }
    }
    const nodes = [...visited]
      .map((key) => this.scripts.get(key))
      .filter((item): item is IndexedScript => Boolean(item))
      .map((item) => ({ path: item.path, className: item.className }));
    const unresolved = [...(this.unresolvedRequires.get(rootKey) ?? [])];
    return { nodes, edges, unresolvedRequires: unresolved };
  }

  getImpact(pathInput: unknown, depthInput = 1): { impactedNodes: GraphNode[]; edges: GraphEdge[] } | null {
    const path = normalizePath(pathInput);
    const rootKey = pathKey(path);
    if (!this.scripts.has(rootKey)) {
      return null;
    }
    const depth = Math.max(1, Math.min(8, Math.trunc(depthInput)));
    const visited = new Set<string>([rootKey]);
    const queue: Array<{ key: string; level: number }> = [{ key: rootKey, level: 0 }];
    const edges: GraphEdge[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.level >= depth) {
        continue;
      }
      const dependents = this.impact.get(current.key) ?? new Set<string>();
      for (const dependent of dependents) {
        edges.push({
          from: this.scripts.get(dependent)!.path,
          to: this.scripts.get(current.key)!.path
        });
        if (!visited.has(dependent)) {
          visited.add(dependent);
          queue.push({ key: dependent, level: current.level + 1 });
        }
      }
    }
    const impactedNodes = [...visited]
      .filter((key) => key !== rootKey)
      .map((key) => this.scripts.get(key))
      .filter((item): item is IndexedScript => Boolean(item))
      .map((item) => ({ path: item.path, className: item.className }));
    impactedNodes.sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
    return { impactedNodes, edges };
  }

  getContextBundle(options: {
    entryPaths: unknown;
    query?: string;
    budgetTokens?: number;
    dependencyDepth?: number;
  }): { chunks: ContextChunk[]; usedBudget: number; truncated: boolean } {
    const entryPaths = Array.isArray(options.entryPaths) ? options.entryPaths.map((item) => normalizePath(item)) : [];
    const budgetTokens = Math.max(200, Math.min(Math.trunc(options.budgetTokens ?? 2000), 12_000));
    const dependencyDepth = Math.max(1, Math.min(6, Math.trunc(options.dependencyDepth ?? 1)));
    const query = options.query?.trim() ?? "";
    const chunks: ContextChunk[] = [];
    let usedBudget = 0;
    let truncated = false;

    const orderedKeys: string[] = [];
    const added = new Set<string>();
    for (const path of entryPaths) {
      const key = pathKey(path);
      if (this.scripts.has(key) && !added.has(key)) {
        orderedKeys.push(key);
        added.add(key);
      }
    }

    for (const key of [...orderedKeys]) {
      const sourceScript = this.scripts.get(key);
      if (!sourceScript) {
        continue;
      }
      const graph = this.getDependencies(sourceScript.path, dependencyDepth);
      if (!graph) {
        continue;
      }
      for (const node of graph.nodes) {
        const nodeKey = pathKey(node.path);
        if (!added.has(nodeKey)) {
          orderedKeys.push(nodeKey);
          added.add(nodeKey);
        }
      }
    }

    if (query) {
      const queryHits = this.searchText(query, { limit: 10 });
      for (const hit of queryHits) {
        const key = pathKey(hit.path);
        if (!added.has(key)) {
          orderedKeys.push(key);
          added.add(key);
        }
      }
    }

    for (const key of orderedKeys) {
      const script = this.scripts.get(key);
      if (!script) {
        continue;
      }
      const perScriptChunks = this.contextChunksForScript(script, query);
      for (const chunk of perScriptChunks) {
        const chunkTokens = approxTokenCount(chunk.content);
        if (usedBudget + chunkTokens > budgetTokens) {
          truncated = true;
          return { chunks, usedBudget, truncated };
        }
        usedBudget += chunkTokens;
        chunks.push(chunk);
      }
    }

    return { chunks, usedBudget, truncated };
  }

  getProjectSummary(options: { service?: string } = {}): ProjectSummary {
    const scripts = [...this.scripts.values()].filter((script) => this.matchesFilter(script, { service: options.service }));
    const classCounts = new Map<string, number>();
    const serviceCounts = new Map<string, number>();
    const entrypointScores: Array<{ path: string[]; score: number; reason: string }> = [];
    const hotSpotScores: Array<{ path: string[]; score: number; reason: string }> = [];

    for (const script of scripts) {
      classCounts.set(script.className, (classCounts.get(script.className) ?? 0) + 1);
      serviceCounts.set(script.service, (serviceCounts.get(script.service) ?? 0) + 1);

      const dependencyCount = this.dependencies.get(script.key)?.size ?? 0;
      const dependentCount = this.impact.get(script.key)?.size ?? 0;
      const referenceCount = this.referencesForKey(script.key);

      let entrypointScore = 0;
      if (script.className === "Script") {
        entrypointScore += 8;
      } else if (script.className === "LocalScript") {
        entrypointScore += 6;
      } else {
        entrypointScore += 2;
      }
      entrypointScore += Math.min(4, dependentCount);
      entrypointScore += Math.min(3, dependencyCount);
      if (script.service === "StarterPlayer" || script.service === "StarterGui" || script.service === "ServerScriptService") {
        entrypointScore += 2;
      }
      entrypointScores.push({
        path: script.path,
        score: entrypointScore,
        reason: `class=${script.className}, dependents=${dependentCount}, deps=${dependencyCount}`
      });

      const hotSpotScore = referenceCount + dependentCount * 2 + dependencyCount;
      hotSpotScores.push({
        path: script.path,
        score: hotSpotScore,
        reason: `references=${referenceCount}, dependents=${dependentCount}, deps=${dependencyCount}`
      });
    }

    return {
      totalScripts: scripts.length,
      moduleCount: scripts.filter((script) => script.className === "ModuleScript").length,
      classCounts: this.mapToSummaryItems(classCounts),
      services: this.mapToSummaryItems(serviceCounts),
      likelyEntrypoints: this.limitPathReasons(entrypointScores, 5),
      hotSpots: this.limitPathReasons(hotSpotScores, 5)
    };
  }

  findEntrypoints(options: { query?: string; service?: string; limit?: number } = {}): EntrypointHit[] {
    const query = options.query?.trim().toLowerCase() ?? "";
    const limit = clampLimit(options.limit, 20, 100);
    const out: EntrypointHit[] = [];
    for (const script of this.scripts.values()) {
      if (options.service && script.service !== options.service) {
        continue;
      }
      const summary = this.fileSummaries.get(script.key);
      const entry = this.computeEntrypoint(script, summary);
      if (!entry) {
        continue;
      }
      if (query && !`${script.path.join("/")} ${entry.reasons.join(" ")}`.toLowerCase().includes(query)) {
        continue;
      }
      out.push(entry);
    }
    out.sort((a, b) => b.score - a.score || a.path.join("/").localeCompare(b.path.join("/")));
    return out.slice(0, limit);
  }

  findRemotes(options: { query?: string; limit?: number } = {}): RemoteHit[] {
    const query = options.query?.trim().toLowerCase() ?? "";
    const limit = clampLimit(options.limit, 20, 100);
    const out = [...this.remoteIndex.values()]
      .map((remote) => this.toRemoteHit(remote))
      .filter((remote) => !looksNoisyRemoteName(remote.name))
      .filter((remote) => {
        if (!query) {
          return true;
        }
        const haystack = `${remote.name} ${remote.inferredPath?.join("/") ?? ""} ${remote.snippets.join(" ")}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) =>
        b.confidence - a.confidence
        || Number(Boolean(b.inferredPath)) - Number(Boolean(a.inferredPath))
        || b.score - a.score
        || a.name.localeCompare(b.name)
      );
    return out.slice(0, limit);
  }

  rankFilesByRelevance(
    queryInput: string,
    options: { limit?: number; uiHits?: Array<{ path: string[] }>; remoteHits?: RemoteHit[] } = {}
  ): RankedFileHit[] {
    const query = String(queryInput ?? "").trim();
    if (!query) {
      return [];
    }
    const limit = clampLimit(options.limit, 20, 100);
    const textHits = this.searchText(query, { limit: 200 });
    const symbolHits = this.findSymbols({ name: query, limit: 200 });
    const remoteHits = options.remoteHits ?? this.findRemotes({ query, limit: 50 });
    const uiHits = options.uiHits ?? [];
    const ranked = new Map<string, RankedFileHit>();

    const ensure = (script: IndexedScript): RankedFileHit => {
      if (!ranked.has(script.key)) {
        ranked.set(script.key, {
          path: script.path,
          className: script.className,
          score: 0,
          why: [],
          textHits: 0,
          symbolHits: 0,
          dependencyHits: 0,
          uiHits: 0,
          remoteHits: 0
        });
      }
      return ranked.get(script.key)!;
    };

    for (const hit of textHits) {
      const script = this.scripts.get(pathKey(hit.path));
      if (!script) {
        continue;
      }
      const item = ensure(script);
      item.textHits = (item.textHits ?? 0) + hit.score;
      item.score += hit.score * 4;
      item.why.push(`text:${hit.score}`);
    }

    for (const hit of symbolHits) {
      const script = this.scripts.get(pathKey(hit.path));
      if (!script) {
        continue;
      }
      const item = ensure(script);
      item.symbolHits = (item.symbolHits ?? 0) + 1;
      item.score += 6;
      item.why.push(`symbol:${hit.symbol}`);
    }

    for (const remote of remoteHits) {
      for (const participant of [...remote.emitters, ...remote.handlers]) {
        const script = this.scripts.get(pathKey(participant.path));
        if (!script) {
          continue;
        }
        const item = ensure(script);
        item.remoteHits = (item.remoteHits ?? 0) + 1;
        item.score += 5;
        item.why.push(`remote:${remote.name}`);
      }
    }

    if (uiHits.length > 0) {
      for (const script of this.scripts.values()) {
        if (script.service === "StarterGui" || script.service === "ReplicatedFirst" || script.service === "StarterPlayer") {
          const item = ensure(script);
          item.uiHits = (item.uiHits ?? 0) + uiHits.length;
          item.score += Math.min(8, uiHits.length * 2);
          item.why.push(`ui:${uiHits.length}`);
        }
      }
    }

    for (const [key, item] of ranked.entries()) {
      const summary = this.fileSummaries.get(key);
      if (!summary) {
        continue;
      }
      const dependencyBoost = Math.min(6, summary.dependencyCount + summary.impactCount);
      item.dependencyHits = dependencyBoost;
      item.score += dependencyBoost;
      if (summary.impactCount > 0) {
        item.why.push(`impact:${summary.impactCount}`);
      }
      if (summary.dependencyCount > 0) {
        item.why.push(`deps:${summary.dependencyCount}`);
      }
      item.score += item.className === "Script" ? 2 : item.className === "LocalScript" ? 1 : 0;
      item.why = [...new Set(item.why)].slice(0, 6);
    }

    return [...ranked.values()]
      .sort((a, b) => b.score - a.score || a.path.join("/").localeCompare(b.path.join("/")))
      .slice(0, limit);
  }

  getSymbolContext(symbolInput: string, budgetTokensInput = 1400): {
    symbol: string;
    definition: SymbolHit | null;
    references: ReferenceHit[];
    relatedScripts: ProjectPathReason[];
    chunks: ContextChunk[];
    usedBudget: number;
    truncated: boolean;
    recommendedNextCalls: string[];
  } {
    const symbol = symbolInput.trim();
    const definition = this.resolveBestSymbolDefinition(symbol);
    const references = this.findReferences(symbol, { limit: 25 });
    if (!definition) {
      return {
        symbol,
        definition: null,
        references: [],
        relatedScripts: [],
        chunks: [],
        usedBudget: 0,
        truncated: false,
        recommendedNextCalls: ["rbx_find_symbols", "rbx_search_text"]
      };
    }
    const bundle = this.getContextBundle({
      entryPaths: [definition.path, ...references.slice(0, 5).map((reference) => reference.path)],
      query: symbol,
      budgetTokens: Math.max(400, Math.min(Math.trunc(budgetTokensInput ?? 1400), 4000)),
      dependencyDepth: 1
    });
    const dependencies = this.getDependencies(definition.path, 1);
    const impact = this.getImpact(definition.path, 1);
    return {
      symbol,
      definition,
      references,
      relatedScripts: this.limitPathReasons([
        ...(dependencies?.nodes ?? [])
          .filter((node) => pathKey(node.path) !== pathKey(definition.path))
          .map((node) => ({ path: node.path, score: 4, reason: "dependency" })),
        ...(impact?.impactedNodes ?? []).map((node) => ({ path: node.path, score: 4, reason: "dependent" })),
        ...references.map((reference) => ({
          path: reference.path,
          score: reference.isDefinition ? 5 : 3,
          reason: reference.isDefinition ? "definition" : "reference"
        }))
      ], 12),
      chunks: bundle.chunks,
      usedBudget: bundle.usedBudget,
      truncated: bundle.truncated,
      recommendedNextCalls: ["rbx_find_references", "rbx_get_related_context", "rbx_get_script_range"]
    };
  }

  resolveBestSymbolDefinition(symbolInput: string): SymbolHit | null {
    const symbol = symbolInput.trim().toLowerCase();
    if (!symbol) {
      return null;
    }
    const candidates = [...(this.symbolsByName.get(symbol) ?? [])];
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      const aRefs = this.referencesForKey(a.key);
      const bRefs = this.referencesForKey(b.key);
      return (
        bRefs - aRefs ||
        a.path.join("/").localeCompare(b.path.join("/")) ||
        a.line - b.line ||
        a.col - b.col
      );
    });
    const winner = candidates[0];
    return {
      symbol: winner.symbol,
      kind: winner.kind,
      path: winner.path,
      line: winner.line,
      col: winner.col,
      container: winner.container
    };
  }

  pathExists(pathInput: unknown): boolean {
    return this.scripts.has(pathKey(normalizePath(pathInput)));
  }

  scriptCount(): number {
    return this.scripts.size;
  }

  private clearInMemory(): void {
    this.scripts.clear();
    this.textPostings.clear();
    this.symbolsByName.clear();
    this.referencesByName.clear();
    this.dependencies.clear();
    this.unresolvedRequires.clear();
    this.impact.clear();
    this.remoteIndex.clear();
    this.fileSummaries.clear();
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = this.indexFilePath();
    if (!filePath) {
      return;
    }
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedIndex>;
      if (parsed.version !== INDEX_VERSION || parsed.placeId !== this.placeId || !Array.isArray(parsed.scripts)) {
        return;
      }
      const scripts: ScriptSnapshot[] = [];
      for (const record of parsed.scripts) {
        if (!record || !Array.isArray(record.path) || typeof record.source !== "string") {
          continue;
        }
        scripts.push({
          path: record.path.map((segment) => String(segment)),
          service: typeof record.service === "string" ? record.service : serviceFromPath(record.path as string[]),
          name: typeof record.name === "string" ? record.name : scriptNameFromPath(record.path as string[]),
          className: record.className as ScriptClass,
          source: record.source,
          hash: String(record.hash ?? ""),
          updatedAt: String(record.updatedAt ?? new Date().toISOString()),
          draftAware: record.draftAware === true,
          readChannel: record.readChannel === "editor" ? "editor" : "unknown",
          tags: Array.isArray(record.tags) ? record.tags.map((entry) => String(entry)) : [],
          attributes: typeof record.attributes === "object" && record.attributes ? { ...record.attributes } : {}
        });
      }
      this.rebuildFromSnapshots(scripts);
    } catch {
      // Ignore malformed index; caller will rebuild from cache.
    }
  }

  private async persist(): Promise<void> {
    const filePath = this.indexFilePath();
    if (!filePath || !this.placeId) {
      return;
    }
    const payload: PersistedIndex = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      placeId: this.placeId,
      scripts: [...this.scripts.values()].map((script) => ({
        path: script.path,
        service: script.service,
        name: script.name,
        className: script.className,
        source: script.source,
        hash: script.hash,
        updatedAt: script.updatedAt,
        draftAware: script.draftAware,
        readChannel: script.readChannel,
        tags: [...script.tags],
        attributes: { ...script.attributes }
      }))
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    await this.cache.setIndexMetadata(INDEX_VERSION, payload.updatedAt);
  }

  private indexFilePath(): string | null {
    const placeDir = this.cache.getActivePlaceDir();
    if (!placeDir) {
      return null;
    }
    return join(placeDir, INDEX_FILE);
  }

  private rebuildFromSnapshots(scripts: ScriptSnapshot[]): void {
    this.clearInMemory();
    for (const script of scripts) {
      const key = pathKey(script.path);
      this.scripts.set(key, { ...script, source: compactSourceForIndex(script.source), key });
    }
    this.rebuildSecondaryIndexes();
  }

  private rebuildSecondaryIndexes(): void {
    this.textPostings.clear();
    this.symbolsByName.clear();
    this.referencesByName.clear();
    this.dependencies.clear();
    this.unresolvedRequires.clear();
    this.impact.clear();
    this.remoteIndex.clear();
    this.fileSummaries.clear();

    for (const script of this.scripts.values()) {
      this.indexText(script);
      this.indexSymbolsAndReferences(script);
    }
    this.recomputeDependencies();
    this.recomputeRemoteIndex();
    this.recomputeFileSummaries();
  }

  private indexText(script: IndexedScript): void {
    const tokens = new Map<string, number>();
    for (const token of tokenize(`${script.path.join(" ")} ${script.source}`)) {
      tokens.set(token, (tokens.get(token) ?? 0) + 1);
    }
    for (const [token, count] of tokens.entries()) {
      if (!this.textPostings.has(token)) {
        this.textPostings.set(token, new Map<string, number>());
      }
      this.textPostings.get(token)!.set(script.key, count);
    }
  }

  private indexSymbolsAndReferences(script: IndexedScript): void {
    const source = script.source;
    const starts = lineStarts(source);
    const definitionOffsets = new Set<string>();
    const addSymbol = (
      symbol: string,
      kind: SymbolKind,
      offset: number,
      container: string | null,
      markAsDefinition = true
    ): void => {
      const location = locateOffset(source, starts, offset);
      const item: SymbolInternal = {
        key: script.key,
        symbol,
        kind,
        path: script.path,
        line: location.line,
        col: location.col,
        container
      };
      const nameKey = symbol.toLowerCase();
      if (!this.symbolsByName.has(nameKey)) {
        this.symbolsByName.set(nameKey, []);
      }
      this.symbolsByName.get(nameKey)!.push(item);
      if (markAsDefinition) {
        definitionOffsets.add(`${nameKey}:${offset}`);
      }
    };

    const localFunctionRe = /^\s*local\s+function\s+([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)\s*\(/gm;
    let localFunction: RegExpExecArray | null;
    while ((localFunction = localFunctionRe.exec(source)) !== null) {
      addSymbol(localFunction[1], "function", localFunction.index + localFunction[0].indexOf(localFunction[1]), null);
    }

    const functionRe =
      /^\s*function\s+([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)([:.]([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*))?\s*\(/gm;
    let globalFunction: RegExpExecArray | null;
    while ((globalFunction = functionRe.exec(source)) !== null) {
      const owner = globalFunction[1];
      const method = globalFunction[3];
      if (method) {
        addSymbol(method, "method", globalFunction.index + globalFunction[0].lastIndexOf(method), owner);
      } else {
        addSymbol(owner, "function", globalFunction.index + globalFunction[0].indexOf(owner), null);
      }
    }

    const localAssignRe = /^\s*local\s+([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)\s*=/gm;
    let localAssign: RegExpExecArray | null;
    while ((localAssign = localAssignRe.exec(source)) !== null) {
      addSymbol(localAssign[1], "local", localAssign.index + localAssign[0].indexOf(localAssign[1]), null);
    }

    const tableRe = /^\s*([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)\s*=\s*\{/gm;
    let tableAssign: RegExpExecArray | null;
    while ((tableAssign = tableRe.exec(source)) !== null) {
      addSymbol(tableAssign[1], "table", tableAssign.index + tableAssign[0].indexOf(tableAssign[1]), null);
    }

    const moduleRe = /^\s*return\s+([A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)\s*$/gm;
    let moduleReturn: RegExpExecArray | null;
    while ((moduleReturn = moduleRe.exec(source)) !== null) {
      addSymbol(moduleReturn[1], "module", moduleReturn.index + moduleReturn[0].indexOf(moduleReturn[1]), null, false);
    }

    for (const token of collectIdentifierTokens(source)) {
      const symbol = token.value;
      const location = locateOffset(source, starts, token.offset);
      const nameKey = symbol.toLowerCase();
      const reference: ReferenceInternal = {
        key: script.key,
        symbol,
        path: script.path,
        line: location.line,
        col: location.col,
        snippet: location.lineText.trim().slice(0, 240),
        isDefinition: definitionOffsets.has(`${nameKey}:${token.offset}`)
      };
      if (!this.referencesByName.has(nameKey)) {
        this.referencesByName.set(nameKey, []);
      }
      this.referencesByName.get(nameKey)!.push(reference);
    }
  }

  private recomputeDependencies(): void {
    for (const script of this.scripts.values()) {
      const targets = new Set<string>();
      const unresolved: string[] = [];
      for (const requireCall of parseRequireCalls(script.source)) {
        const resolved = resolveRequirePath(requireCall.expression, script.path);
        if (!resolved) {
          unresolved.push(requireCall.expression);
          continue;
        }
        const targetKey = pathKey(resolved);
        if (this.scripts.has(targetKey)) {
          targets.add(targetKey);
        } else {
          unresolved.push(requireCall.expression);
        }
      }
      this.dependencies.set(script.key, targets);
      this.unresolvedRequires.set(script.key, unresolved);
    }

    for (const [from, targets] of this.dependencies.entries()) {
      for (const to of targets) {
        if (!this.impact.has(to)) {
          this.impact.set(to, new Set<string>());
        }
        this.impact.get(to)!.add(from);
      }
    }
  }

  private recomputeRemoteIndex(): void {
    for (const script of this.scripts.values()) {
      const lines = script.source.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_:.()"']+?)\s*:\s*(FireServer|FireClient|FireAllClients|InvokeServer|InvokeClient)\s*\(/g)) {
          const remote = this.parseRemoteExpression(match[1], script.path);
          if (!remote.name) {
            continue;
          }
          this.registerRemoteParticipant(remote, detectRemoteKind(match[2]), "emitter", {
            key: script.key,
            path: script.path,
            action: match[2],
            snippet: previewText(line, 180)
          });
        }
        for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_:.()"']+?)\.(OnServerEvent|OnClientEvent|OnServerInvoke|OnClientInvoke)/g)) {
          const remote = this.parseRemoteExpression(match[1], script.path);
          if (!remote.name) {
            continue;
          }
          this.registerRemoteParticipant(remote, detectRemoteKind(match[2]), "handler", {
            key: script.key,
            path: script.path,
            action: match[2],
            snippet: previewText(line, 180)
          });
        }
      }
    }
  }

  private recomputeFileSummaries(): void {
    for (const script of this.scripts.values()) {
      const summary: FileSummaryInternal = {
        key: script.key,
        dependencyCount: this.dependencies.get(script.key)?.size ?? 0,
        impactCount: this.impact.get(script.key)?.size ?? 0,
        referenceCount: this.referencesForKey(script.key),
        symbolCount: this.symbolCountForKey(script.key)
      };
      this.fileSummaries.set(script.key, summary);
    }
  }

  private findTextMatches(source: string, queryLower: string): TextMatch[] {
    const out: TextMatch[] = [];
    const lower = source.toLowerCase();
    const starts = lineStarts(source);
    let idx = lower.indexOf(queryLower);
    while (idx >= 0 && out.length < MAX_SEARCH_MATCHES_PER_SCRIPT) {
      const location = locateOffset(source, starts, idx);
      out.push({
        line: location.line,
        startCol: location.col,
        endCol: location.col + queryLower.length - 1,
        snippet: location.lineText.trim().slice(0, 240)
      });
      idx = lower.indexOf(queryLower, idx + Math.max(1, queryLower.length));
    }
    return out;
  }

  private contextChunksForScript(script: IndexedScript, query: string): ContextChunk[] {
    const sourceLines = script.source.split("\n");
    if (!query) {
      const endLine = Math.min(sourceLines.length, 80);
      return [
        {
          path: script.path,
          startLine: 1,
          endLine,
          reason: "entry_or_dependency",
          content: sourceLines.slice(0, endLine).join("\n")
        }
      ];
    }

    const lineHits = this.findTextMatches(script.source, query.toLowerCase()).map((match) => match.line);
    if (lineHits.length === 0) {
      const endLine = Math.min(sourceLines.length, 40);
      return [
        {
          path: script.path,
          startLine: 1,
          endLine,
          reason: "fallback_context",
          content: sourceLines.slice(0, endLine).join("\n")
        }
      ];
    }

    const chunks: ContextChunk[] = [];
    for (const hitLine of lineHits.slice(0, 3)) {
      let startLine = Math.max(1, hitLine - 4);
      let endLine = Math.min(sourceLines.length, hitLine + 4);
      for (let line = hitLine; line >= Math.max(1, hitLine - 25); line -= 1) {
        const text = sourceLines[line - 1]?.trim() ?? "";
        if (/^(local\s+function|function\s+|return\s+function\b)/.test(text)) {
          startLine = line;
          break;
        }
      }
      for (let line = hitLine; line <= Math.min(sourceLines.length, hitLine + 60); line += 1) {
        const text = sourceLines[line - 1]?.trim() ?? "";
        if (line > hitLine && /^end\b/.test(text)) {
          endLine = line;
          break;
        }
      }
      chunks.push({
        path: script.path,
        startLine,
        endLine,
        reason: "query_match",
        content: sourceLines.slice(startLine - 1, endLine).join("\n")
      });
    }
    return chunks;
  }

  private matchesFilter(script: IndexedScript, filter: QueryFilter): boolean {
    if (filter.service && script.service !== filter.service) {
      return false;
    }
    return pathMatchesPrefix(script.path, filter.pathPrefix);
  }

  private referencesForKey(key: string): number {
    let count = 0;
    for (const refs of this.referencesByName.values()) {
      for (const ref of refs) {
        if (ref.key === key) {
          count += 1;
        }
      }
    }
    return count;
  }

  private symbolCountForKey(key: string): number {
    let count = 0;
    for (const symbols of this.symbolsByName.values()) {
      for (const symbol of symbols) {
        if (symbol.key === key) {
          count += 1;
        }
      }
    }
    return count;
  }

  private mapToSummaryItems(map: Map<string, number>): ProjectSummaryItem[] {
    return [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  private limitPathReasons(items: Array<{ path: string[]; score: number; reason: string }>, limit: number): ProjectPathReason[] {
    return items
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.join("/").localeCompare(b.path.join("/")))
      .slice(0, limit)
      .map((item) => ({
        path: item.path,
        reason: previewText(item.reason, 100)
      }));
  }

  private computeEntrypoint(script: IndexedScript, summary?: FileSummaryInternal): EntrypointHit | null {
    const reasons: string[] = [];
    const lowerSource = script.source.toLowerCase();
    let category: EntrypointCategory | null = null;
    let score = 0;

    if (script.className === "Script" && (script.service === "ServerScriptService" || script.service === "ServerStorage")) {
      category = "server_bootstrap";
      score += 8;
      reasons.push(`service=${script.service}`);
    }
    if (script.className === "LocalScript" && (script.service === "StarterPlayer" || script.service === "StarterGui" || script.service === "ReplicatedFirst")) {
      category = category ?? "client_bootstrap";
      score += 7;
      reasons.push(`client_service=${script.service}`);
    }
    if (/(mousebutton1click|activated|focuslost)/i.test(script.source)) {
      category = "ui_controller";
      score += 7;
      reasons.push("ui_event_hook");
    }
    if (/(onserverevent|onclientevent|onserverinvoke|onclientinvoke)/i.test(script.source)) {
      category = "remote_handler";
      score += 8;
      reasons.push("remote_handler");
    }
    if (/(playeradded|game\.loaded|runservice)/i.test(lowerSource)) {
      score += 4;
      reasons.push("lifecycle_hook");
    }
    if (script.className === "ModuleScript" && (summary?.impactCount ?? 0) >= 2) {
      category = category ?? "high_fan_in_module";
      score += 6;
      reasons.push(`fan_in=${summary?.impactCount ?? 0}`);
    }
    score += Math.min(4, summary?.impactCount ?? 0);
    score += Math.min(3, summary?.dependencyCount ?? 0);

    if (!category || score <= 0) {
      return null;
    }
    score += categoryWeight(category);
    return {
      path: script.path,
      className: script.className,
      score,
      reasons: [...new Set(reasons)].slice(0, 5),
      category
    };
  }

  private parseRemoteExpression(expression: string, currentPath: string[]): { key: string; name: string; inferredPath: string[] | null } {
    const compact = cleanupRemoteExpression(expression.replace(/\s+/g, ""));
    const waitChild = compact.match(/^(.+):WaitForChild\(["']([A-Za-z_][A-Za-z0-9_]*)["']\)$/);
    if (waitChild) {
      const base = this.parseRemoteExpression(waitChild[1], currentPath);
      return {
        key: base.inferredPath ? pathKey([...base.inferredPath, waitChild[2]]) : waitChild[2].toLowerCase(),
        name: waitChild[2],
        inferredPath: base.inferredPath ? [...base.inferredPath, waitChild[2]] : null
      };
    }
    const resolved = resolveRequirePath(compact, currentPath);
    if (resolved) {
      return {
        key: pathKey(resolved),
        name: resolved[resolved.length - 1],
        inferredPath: resolved
      };
    }
    const dottedName = compact.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    const name = cleanupRemoteExpression(dottedName ? dottedName[1] : compact);
    if (!name || looksNoisyRemoteName(name)) {
      return {
        key: "",
        name: "",
        inferredPath: null
      };
    }
    return {
      key: name.toLowerCase(),
      name,
      inferredPath: null
    };
  }

  private registerRemoteParticipant(
    remoteInfo: { key: string; name: string; inferredPath: string[] | null },
    kind: "RemoteEvent" | "RemoteFunction" | "unknown",
    side: "emitter" | "handler",
    participant: RemoteParticipant & { key: string; snippet: string }
  ): void {
    if (!remoteInfo.key || !remoteInfo.name) {
      return;
    }
    if (!this.remoteIndex.has(remoteInfo.key)) {
      this.remoteIndex.set(remoteInfo.key, {
        key: remoteInfo.key,
        name: remoteInfo.name,
        inferredPath: remoteInfo.inferredPath,
        kind,
        emitters: [],
        handlers: []
      });
    }
    const remote = this.remoteIndex.get(remoteInfo.key)!;
    remote.kind = remote.kind === "unknown" ? kind : remote.kind;
    if (!remote.inferredPath && remoteInfo.inferredPath) {
      remote.inferredPath = remoteInfo.inferredPath;
    }
    const target = side === "emitter" ? remote.emitters : remote.handlers;
    if (!target.some((item) => item.key === participant.key && item.action === participant.action && item.snippet === participant.snippet)) {
      target.push(participant);
    }
  }

  private toRemoteHit(remote: RemoteInternal): RemoteHit {
    const emitters = remote.emitters
      .map((item) => ({ path: item.path, action: item.action }))
      .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")) || a.action.localeCompare(b.action));
    const handlers = remote.handlers
      .map((item) => ({ path: item.path, action: item.action }))
      .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")) || a.action.localeCompare(b.action));
    const snippets = [...new Set([...remote.emitters, ...remote.handlers].map((item) => item.snippet))].slice(0, 5);
    const evidence = [...new Set([
      ...(remote.inferredPath ? ["literal_path"] : ["name_only"]),
      ...(emitters.length > 0 ? ["emitter_pair"] : []),
      ...(handlers.length > 0 ? ["handler_pair"] : [])
    ])].slice(0, 8);
    const argHints = [...new Set(snippets.map((snippet) => {
      const match = snippet.match(/\(([^)]{1,80})\)/);
      return match ? previewText(match[1], 60) : "";
    }).filter(Boolean))].slice(0, 5);
    const pairedParticipants = [...new Set([...emitters, ...handlers].map((item) => item.path.join("/")))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 10)
      .map((item) => item.split("/"));
    let score = emitters.length * 2 + handlers.length * 2 + (remote.inferredPath ? 10 : -5);
    if (emitters.length > 0 && handlers.length > 0) {
      score += remote.inferredPath ? 6 : 2;
    }
    if (pairedParticipants.length >= 2) {
      score += remote.inferredPath ? 3 : 1;
    }
    if (!remote.inferredPath && evidence.length === 2 && evidence.includes("name_only")) {
      score -= 3;
    }
    if (looksNoisyRemoteName(remote.name)) {
      score -= 12;
    }
    const confidence = Math.max(
      0.1,
      Math.min(
        0.98,
        (remote.inferredPath ? 0.58 : 0.12)
          + Math.min(0.25, emitters.length * 0.04)
          + Math.min(0.25, handlers.length * 0.05)
          + (emitters.length > 0 && handlers.length > 0 ? (remote.inferredPath ? 0.12 : 0.06) : 0)
      )
    );
    return {
      name: remote.name,
      kind: remote.kind,
      inferredPath: remote.inferredPath ? [...remote.inferredPath] : null,
      emitters,
      handlers,
      score,
      snippets,
      confidence,
      evidence,
      argHints,
      pairedParticipants,
      unresolvedPath: remote.inferredPath == null
    };
  }
}
