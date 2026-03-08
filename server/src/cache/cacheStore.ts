import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CacheIndex,
  ChangeJournalChangeType,
  ChangeJournalEntry,
  ScriptIndexRecord,
  ScriptReadChannel,
  ScriptSnapshot,
  ScriptWriteChannel,
  StudioSession,
  UiNodeSnapshot,
  UiRootIndexRecord
} from "../domain/types.js";
import { digestForFileKey, normalizeSource, sourceHash } from "../lib/hash.js";
import { pathKey, scriptNameFromPath, serviceFromPath } from "../lib/path.js";

const INDEX_FILE = "index.json";
const CHANGE_JOURNAL_FILE = "change-journal.json";
const SCRIPT_HISTORY_FILE = "script-history.json";
const SCRIPTS_DIR = "scripts";
const UI_DIR = "ui";
const SCRIPT_HISTORY_DIR = "script-history";
const DEFAULT_WRITE_MODE = "draft_only" as const;
const DEFAULT_READ_CHANNEL: ScriptReadChannel = "unknown";
const CHANGE_JOURNAL_RETENTION = 5_000;
const SCRIPT_HISTORY_RETENTION = 10;

interface ScriptHistoryRecord {
  hash: string;
  updatedAt: string;
  sourceFile: string;
}

function normalizeReadChannel(input: unknown): ScriptReadChannel {
  return input === "editor" ? "editor" : "unknown";
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeDirName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeExternalHash(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim().toLowerCase();
  return /^[0-9a-f]{8}$/.test(value) ? value : null;
}

function cloneUiNode(node: UiNodeSnapshot): UiNodeSnapshot {
  return {
    path: [...node.path],
    service: node.service,
    name: node.name,
    className: node.className,
    version: node.version,
    updatedAt: node.updatedAt,
    props: { ...node.props },
    unsupportedProperties: [...node.unsupportedProperties],
    children: node.children.map((child) => cloneUiNode(child))
  };
}

function sanitizeUiNode(node: UiNodeSnapshot): UiNodeSnapshot {
  return {
    path: Array.isArray(node.path) ? node.path.map((segment) => String(segment)) : [],
    service: String(node.service ?? serviceFromPath(node.path)),
    name: String(node.name ?? node.path[node.path.length - 1] ?? "Unknown"),
    className: String(node.className ?? "Frame"),
    version: String(node.version ?? sourceHash(JSON.stringify(node.props ?? {}))),
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : nowIso(),
    props: typeof node.props === "object" && node.props ? { ...node.props } : {},
    unsupportedProperties: Array.isArray(node.unsupportedProperties)
      ? node.unsupportedProperties.map((entry) => String(entry))
      : [],
    children: Array.isArray(node.children) ? node.children.map((child) => sanitizeUiNode(child)) : []
  };
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
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

function findUiNode(node: UiNodeSnapshot, path: string[]): UiNodeSnapshot | null {
  if (pathKey(node.path) === pathKey(path)) {
    return node;
  }
  for (const child of node.children) {
    const found = findUiNode(child, path);
    if (found) {
      return found;
    }
  }
  return null;
}

function limitUiDepth(node: UiNodeSnapshot, depth: number): UiNodeSnapshot {
  const copy = cloneUiNode(node);
  if (depth <= 0) {
    copy.children = [];
    return copy;
  }
  copy.children = node.children.map((child) => limitUiDepth(child, depth - 1));
  return copy;
}

export interface ListScriptsOptions {
  service?: string;
  query?: string;
  limit?: number;
}

export interface ListUiRootsOptions {
  service?: string;
  query?: string;
  limit?: number;
}

export class CacheStore {
  private readonly cacheRoot: string;
  private activeIndex: CacheIndex | null = null;
  private changeJournal: ChangeJournalEntry[] = [];
  private changeCursor = 0;
  private scriptHistoryIndex: Record<string, ScriptHistoryRecord[]> = {};

  constructor(baseDir: string = process.cwd()) {
    this.cacheRoot = join(baseDir, ".rbxmcp", "cache");
  }

  getCacheRoot(): string {
    return this.cacheRoot;
  }

  async bootstrapFromDisk(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true });
    const placeDirs = await readdir(this.cacheRoot, { withFileTypes: true });
    const directories = placeDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (directories.length === 0) {
      return;
    }

    const withTime: Array<{ name: string; mtime: number }> = [];
    for (const dirName of directories) {
      const info = await stat(join(this.cacheRoot, dirName));
      withTime.push({ name: dirName, mtime: info.mtimeMs });
    }
    withTime.sort((a, b) => b.mtime - a.mtime);
    await this.loadPlace(withTime[0].name);
  }

  async setActivePlace(placeId: string, placeName: string): Promise<void> {
    const dirName = safeDirName(placeId);
    if (this.activeIndex?.placeId === dirName) {
      this.activeIndex.placeName = placeName;
      await this.saveIndex();
      return;
    }
    await this.loadPlace(dirName, placeName);
  }

  private async loadPlace(dirName: string, placeName = "Unknown"): Promise<void> {
    await mkdir(join(this.cacheRoot, dirName, SCRIPTS_DIR), { recursive: true });
    await mkdir(join(this.cacheRoot, dirName, UI_DIR), { recursive: true });
    await mkdir(join(this.cacheRoot, dirName, SCRIPT_HISTORY_DIR), { recursive: true });
    const indexPath = join(this.cacheRoot, dirName, INDEX_FILE);
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CacheIndex>;
      const scripts: Record<string, ScriptIndexRecord> = {};
      for (const [key, value] of Object.entries(parsed.scripts ?? {})) {
        const record = value as Partial<ScriptIndexRecord>;
        if (!record || !Array.isArray(record.path) || typeof record.sourceFile !== "string") {
          continue;
        }
        if (record.className !== "Script" && record.className !== "LocalScript" && record.className !== "ModuleScript") {
          continue;
        }
        const recordPath = record.path.map((segment) => String(segment));
        scripts[key] = {
          key: typeof record.key === "string" ? record.key : key,
          path: recordPath,
          service: typeof record.service === "string" ? record.service : serviceFromPath(recordPath),
          name: typeof record.name === "string" ? record.name : scriptNameFromPath(recordPath),
          className: record.className,
          hash: typeof record.hash === "string" ? record.hash : sourceHash(""),
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
          sourceFile: record.sourceFile,
          draftAware: record.draftAware === true,
          readChannel: normalizeReadChannel(record.readChannel)
        };
      }

      const uiRoots: Record<string, UiRootIndexRecord> = {};
      for (const [key, value] of Object.entries(parsed.uiRoots ?? {})) {
        const record = value as Partial<UiRootIndexRecord>;
        if (!record || !Array.isArray(record.path) || typeof record.treeFile !== "string") {
          continue;
        }
        const recordPath = record.path.map((segment) => String(segment));
        uiRoots[key] = {
          key: typeof record.key === "string" ? record.key : key,
          path: recordPath,
          service: typeof record.service === "string" ? record.service : serviceFromPath(recordPath),
          name: typeof record.name === "string" ? record.name : recordPath[recordPath.length - 1] ?? "Unknown",
          className: typeof record.className === "string" ? record.className : "LayerCollector",
          version: typeof record.version === "string" ? record.version : sourceHash(JSON.stringify(recordPath)),
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
          treeFile: record.treeFile
        };
      }

      this.activeIndex = {
        placeId: typeof parsed.placeId === "string" ? parsed.placeId : dirName,
        placeName: typeof parsed.placeName === "string" ? parsed.placeName : placeName,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
        writeMode: DEFAULT_WRITE_MODE,
        editorApiAvailable: typeof parsed.editorApiAvailable === "boolean" ? parsed.editorApiAvailable : null,
        lastReadChannel: parsed.lastReadChannel ? normalizeReadChannel(parsed.lastReadChannel) : null,
        lastWriteChannel: parsed.lastWriteChannel === "editor" ? "editor" : null,
        indexVersion: typeof parsed.indexVersion === "number" ? parsed.indexVersion : null,
        indexUpdatedAt: typeof parsed.indexUpdatedAt === "string" ? parsed.indexUpdatedAt : null,
        uiIndexVersion: typeof parsed.uiIndexVersion === "number" ? parsed.uiIndexVersion : null,
        uiIndexUpdatedAt: typeof parsed.uiIndexUpdatedAt === "string" ? parsed.uiIndexUpdatedAt : null,
        scripts,
        uiRoots
      };
      await this.loadChangeJournal();
      await this.loadScriptHistoryIndex();
      await this.saveIndex();
    } catch {
      this.activeIndex = {
        placeId: dirName,
        placeName,
        updatedAt: nowIso(),
        writeMode: DEFAULT_WRITE_MODE,
        editorApiAvailable: null,
        lastReadChannel: null,
        lastWriteChannel: null,
        indexVersion: null,
        indexUpdatedAt: null,
        uiIndexVersion: null,
        uiIndexUpdatedAt: null,
        scripts: {},
        uiRoots: {}
      };
      this.changeJournal = [];
      this.changeCursor = 0;
      this.scriptHistoryIndex = {};
      await this.saveIndex();
    }
  }

  private requireActive(): CacheIndex {
    if (!this.activeIndex) {
      throw new Error("cache place not selected");
    }
    return this.activeIndex;
  }

  private placeDir(): string {
    return join(this.cacheRoot, this.requireActive().placeId);
  }

  private scriptFileForKey(key: string): string {
    return `${digestForFileKey(key)}.lua`;
  }

  private uiFileForKey(key: string): string {
    return `${digestForFileKey(key)}.json`;
  }

  private async saveIndex(): Promise<void> {
    const active = this.requireActive();
    active.updatedAt = nowIso();
    await writeFile(join(this.placeDir(), INDEX_FILE), JSON.stringify(active, null, 2) + "\n", "utf-8");
  }

  private async saveChangeJournal(): Promise<void> {
    await writeFile(join(this.placeDir(), CHANGE_JOURNAL_FILE), JSON.stringify({
      cursor: this.changeCursor,
      entries: this.changeJournal
    }, null, 2) + "\n", "utf-8");
  }

  private async saveScriptHistoryIndex(): Promise<void> {
    await writeFile(join(this.placeDir(), SCRIPT_HISTORY_FILE), JSON.stringify(this.scriptHistoryIndex, null, 2) + "\n", "utf-8");
  }

  private async loadChangeJournal(): Promise<void> {
    try {
      const raw = await readFile(join(this.placeDir(), CHANGE_JOURNAL_FILE), "utf-8");
      const parsed = JSON.parse(raw) as { cursor?: number; entries?: ChangeJournalEntry[] };
      this.changeJournal = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => ({
            cursor: String(entry.cursor ?? ""),
            time: String(entry.time ?? nowIso()),
            kind: entry.kind === "ui_root" ? "ui_root" : "script",
            path: Array.isArray(entry.path) ? entry.path.map((segment) => String(segment)) : [],
            updatedAt: String(entry.updatedAt ?? nowIso()),
            changeType: typeof entry.changeType === "string" ? entry.changeType as ChangeJournalChangeType : "snapshot_partial"
          }))
        : [];
      this.changeCursor = Number.isFinite(parsed.cursor) ? Math.max(0, Math.trunc(parsed.cursor as number)) : this.changeJournal.reduce((max, entry) => Math.max(max, Number(entry.cursor) || 0), 0);
    } catch {
      this.changeJournal = [];
      this.changeCursor = 0;
    }
  }

  private async loadScriptHistoryIndex(): Promise<void> {
    try {
      const raw = await readFile(join(this.placeDir(), SCRIPT_HISTORY_FILE), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, ScriptHistoryRecord[]>;
      const normalized: Record<string, ScriptHistoryRecord[]> = {};
      for (const [key, entries] of Object.entries(parsed ?? {})) {
        if (!Array.isArray(entries)) {
          continue;
        }
        normalized[key] = entries
          .filter((entry) => entry && typeof entry.hash === "string" && typeof entry.sourceFile === "string")
          .map((entry) => ({
            hash: entry.hash,
            updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso(),
            sourceFile: entry.sourceFile
          }));
      }
      this.scriptHistoryIndex = normalized;
    } catch {
      this.scriptHistoryIndex = {};
    }
  }

  private async appendJournalEntries(
    kind: ChangeJournalEntry["kind"],
    changeType: ChangeJournalChangeType,
    items: Array<{ path: string[]; updatedAt: string }>
  ): Promise<void> {
    for (const item of items) {
      this.changeCursor += 1;
      this.changeJournal.push({
        cursor: String(this.changeCursor),
        time: nowIso(),
        kind,
        path: [...item.path],
        updatedAt: item.updatedAt,
        changeType
      });
    }
    if (this.changeJournal.length > CHANGE_JOURNAL_RETENTION) {
      this.changeJournal.splice(0, this.changeJournal.length - CHANGE_JOURNAL_RETENTION);
    }
    await this.saveChangeJournal();
  }

  async recordChangedItems(
    kind: ChangeJournalEntry["kind"],
    changeType: ChangeJournalChangeType,
    items: Array<{ path: string[]; updatedAt: string }>
  ): Promise<void> {
    await this.appendJournalEntries(kind, changeType, items);
  }

  private historyFileFor(key: string, hash: string, updatedAt: string): string {
    return `${digestForFileKey(`${key}:${hash}:${updatedAt}`)}.lua`;
  }

  private async recordScriptHistory(key: string, source: string, hash: string, updatedAt: string): Promise<void> {
    const history = this.scriptHistoryIndex[key] ?? [];
    const last = history[history.length - 1];
    if (last && last.hash === hash) {
      return;
    }
    const sourceFile = this.historyFileFor(key, hash, updatedAt);
    await writeFile(join(this.placeDir(), SCRIPT_HISTORY_DIR, sourceFile), source, "utf-8");
    history.push({ hash, updatedAt, sourceFile });
    while (history.length > SCRIPT_HISTORY_RETENTION) {
      const removed = history.shift();
      if (removed) {
        await unlink(join(this.placeDir(), SCRIPT_HISTORY_DIR, removed.sourceFile)).catch(() => undefined);
      }
    }
    this.scriptHistoryIndex[key] = history;
    await this.saveScriptHistoryIndex();
  }

  private async deleteScriptHistory(key: string): Promise<void> {
    const history = this.scriptHistoryIndex[key] ?? [];
    for (const entry of history) {
      await unlink(join(this.placeDir(), SCRIPT_HISTORY_DIR, entry.sourceFile)).catch(() => undefined);
    }
    delete this.scriptHistoryIndex[key];
    await this.saveScriptHistoryIndex();
  }

  private async moveScriptHistory(oldKey: string, newKey: string): Promise<void> {
    if (oldKey === newKey) {
      return;
    }
    const history = this.scriptHistoryIndex[oldKey];
    if (!history) {
      return;
    }
    this.scriptHistoryIndex[newKey] = history;
    delete this.scriptHistoryIndex[oldKey];
    await this.saveScriptHistoryIndex();
  }

  private async upsertInternal(input: Omit<ScriptSnapshot, "hash" | "updatedAt"> & { hash?: string }): Promise<ScriptSnapshot> {
    const active = this.requireActive();
    const normalizedSource = normalizeSource(input.source);
    const normalizedPath = input.path.map((segment) => segment.trim());
    const key = pathKey(normalizedPath);
    const hash = normalizeExternalHash(input.hash) ?? sourceHash(normalizedSource);
    const sourceFile = this.scriptFileForKey(key);
    const updatedAt = nowIso();
    await writeFile(join(this.placeDir(), SCRIPTS_DIR, sourceFile), normalizedSource, "utf-8");
    await this.recordScriptHistory(key, normalizedSource, hash, updatedAt);

    const record: ScriptIndexRecord = {
      key,
      path: normalizedPath,
      service: input.service,
      name: input.name,
      className: input.className,
      hash,
      updatedAt,
      sourceFile,
      draftAware: input.draftAware,
      readChannel: input.readChannel
    };
    active.scripts[key] = record;
    active.lastReadChannel = record.readChannel;
    await this.saveIndex();

    return {
      path: record.path,
      service: record.service,
      name: record.name,
      className: record.className,
      source: normalizedSource,
      hash: record.hash,
      updatedAt: record.updatedAt,
      draftAware: record.draftAware,
      readChannel: record.readChannel
    };
  }

  private async upsertUiInternal(root: UiNodeSnapshot): Promise<UiNodeSnapshot> {
    const active = this.requireActive();
    const normalizedRoot = sanitizeUiNode(root);
    const key = pathKey(normalizedRoot.path);
    const treeFile = this.uiFileForKey(key);
    const updatedAt = nowIso();
    normalizedRoot.updatedAt = updatedAt;
    await writeFile(join(this.placeDir(), UI_DIR, treeFile), JSON.stringify(normalizedRoot, null, 2) + "\n", "utf-8");

    active.uiRoots[key] = {
      key,
      path: [...normalizedRoot.path],
      service: normalizedRoot.service,
      name: normalizedRoot.name,
      className: normalizedRoot.className,
      version: normalizedRoot.version,
      updatedAt,
      treeFile
    };
    await this.saveIndex();
    return normalizedRoot;
  }

  async snapshotAll(
    session: Pick<StudioSession, "placeId" | "placeName">,
    scripts: Array<{
      path: string[];
      className: ScriptSnapshot["className"];
      source: string;
      hash?: string;
      draftAware?: boolean;
      readChannel?: ScriptReadChannel;
    }>
  ): Promise<void> {
    await this.setActivePlace(session.placeId, session.placeName);
    const active = this.requireActive();
    const oldFiles = new Set(Object.values(active.scripts).map((record) => record.sourceFile));
    active.scripts = {};

    for (const script of scripts) {
      await this.upsertInternal({
        path: script.path,
        service: serviceFromPath(script.path),
        name: scriptNameFromPath(script.path),
        className: script.className,
        source: script.source,
        hash: script.hash,
        draftAware: script.draftAware ?? false,
        readChannel: script.readChannel ?? DEFAULT_READ_CHANNEL
      });
    }

    const currentFiles = new Set(Object.values(active.scripts).map((record) => record.sourceFile));
    for (const fileName of oldFiles) {
      if (!currentFiles.has(fileName)) {
        await unlink(join(this.placeDir(), SCRIPTS_DIR, fileName)).catch(() => undefined);
      }
    }
    await this.saveIndex();
    await this.appendJournalEntries("script", "snapshot_all", Object.values(active.scripts).map((record) => ({
      path: record.path,
      updatedAt: record.updatedAt
    })));
  }

  async upsertMany(
    session: Pick<StudioSession, "placeId" | "placeName">,
    scripts: Array<{
      path: string[];
      className: ScriptSnapshot["className"];
      source: string;
      hash?: string;
      draftAware?: boolean;
      readChannel?: ScriptReadChannel;
    }>
  ): Promise<void> {
    await this.setActivePlace(session.placeId, session.placeName);
    const changed: Array<{ path: string[]; updatedAt: string }> = [];
    for (const script of scripts) {
      const updated = await this.upsertInternal({
        path: script.path,
        service: serviceFromPath(script.path),
        name: scriptNameFromPath(script.path),
        className: script.className,
        source: script.source,
        hash: script.hash,
        draftAware: script.draftAware ?? false,
        readChannel: script.readChannel ?? DEFAULT_READ_CHANNEL
      });
      changed.push({ path: updated.path, updatedAt: updated.updatedAt });
    }
    await this.saveIndex();
    await this.appendJournalEntries("script", "snapshot_partial", changed);
  }

  async deleteScript(path: string[]): Promise<void> {
    const active = this.requireActive();
    const key = pathKey(path);
    const record = active.scripts[key];
    if (!record) {
      return;
    }
    delete active.scripts[key];
    await unlink(join(this.placeDir(), SCRIPTS_DIR, record.sourceFile)).catch(() => undefined);
    await this.deleteScriptHistory(key);
    await this.saveIndex();
    await this.appendJournalEntries("script", "script_write", [{
      path: [...path],
      updatedAt: nowIso()
    }]);
  }

  async moveScript(oldPath: string[], next: {
    path: string[];
    className: ScriptSnapshot["className"];
    source: string;
    hash?: string;
    draftAware?: boolean;
    readChannel?: ScriptReadChannel;
  }): Promise<ScriptSnapshot> {
    const active = this.requireActive();
    const oldKey = pathKey(oldPath);
    const oldRecord = active.scripts[oldKey];
    const moved = await this.upsertInternal({
      path: next.path,
      service: serviceFromPath(next.path),
      name: scriptNameFromPath(next.path),
      className: next.className,
      source: next.source,
      hash: next.hash,
      draftAware: next.draftAware ?? false,
      readChannel: next.readChannel ?? DEFAULT_READ_CHANNEL
    });
    const newKey = pathKey(next.path);
    if (oldRecord && oldKey !== newKey) {
      delete active.scripts[oldKey];
      await unlink(join(this.placeDir(), SCRIPTS_DIR, oldRecord.sourceFile)).catch(() => undefined);
      await this.moveScriptHistory(oldKey, newKey);
    }
    await this.saveIndex();
    await this.appendJournalEntries("script", "script_write", [
      { path: [...oldPath], updatedAt: moved.updatedAt },
      { path: [...moved.path], updatedAt: moved.updatedAt }
    ]);
    return moved;
  }

  async snapshotUiRoots(session: Pick<StudioSession, "placeId" | "placeName">, roots: UiNodeSnapshot[]): Promise<void> {
    await this.setActivePlace(session.placeId, session.placeName);
    const active = this.requireActive();
    const oldFiles = new Set(Object.values(active.uiRoots).map((record) => record.treeFile));
    active.uiRoots = {};

    for (const root of roots) {
      await this.upsertUiInternal(root);
    }

    const currentFiles = new Set(Object.values(active.uiRoots).map((record) => record.treeFile));
    for (const fileName of oldFiles) {
      if (!currentFiles.has(fileName)) {
        await unlink(join(this.placeDir(), UI_DIR, fileName)).catch(() => undefined);
      }
    }
    await this.saveIndex();
    await this.appendJournalEntries("ui_root", "snapshot_all", Object.values(active.uiRoots).map((record) => ({
      path: record.path,
      updatedAt: record.updatedAt
    })));
  }

  async upsertUiRoots(session: Pick<StudioSession, "placeId" | "placeName">, roots: UiNodeSnapshot[]): Promise<void> {
    await this.setActivePlace(session.placeId, session.placeName);
    const changed: Array<{ path: string[]; updatedAt: string }> = [];
    for (const root of roots) {
      const updated = await this.upsertUiInternal(root);
      changed.push({ path: updated.path, updatedAt: updated.updatedAt });
    }
    await this.saveIndex();
    await this.appendJournalEntries("ui_root", "snapshot_partial", changed);
  }

  async getScript(path: string[]): Promise<ScriptSnapshot | null> {
    const record = this.requireActive().scripts[pathKey(path)];
    if (!record) {
      return null;
    }
    const source = await readFile(join(this.placeDir(), SCRIPTS_DIR, record.sourceFile), "utf-8");
    return {
      path: record.path,
      service: record.service,
      name: record.name,
      className: record.className,
      source,
      hash: record.hash,
      updatedAt: record.updatedAt,
      draftAware: record.draftAware,
      readChannel: record.readChannel
    };
  }

  async getScriptVersion(path: string[], hash: string): Promise<ScriptSnapshot | null> {
    const current = await this.getScript(path);
    if (current?.hash === hash) {
      return current;
    }
    const key = pathKey(path);
    const history = this.scriptHistoryIndex[key] ?? [];
    const match = [...history].reverse().find((entry) => entry.hash === hash);
    if (!match) {
      return null;
    }
    const record = this.requireActive().scripts[key];
    const source = await readFile(join(this.placeDir(), SCRIPT_HISTORY_DIR, match.sourceFile), "utf-8");
    return {
      path: [...path],
      service: record?.service ?? path[0],
      name: record?.name ?? scriptNameFromPath(path),
      className: record?.className ?? "ModuleScript",
      source,
      hash: match.hash,
      updatedAt: match.updatedAt,
      draftAware: record?.draftAware ?? false,
      readChannel: record?.readChannel ?? DEFAULT_READ_CHANNEL
    };
  }

  async getPreviousScriptVersion(path: string[]): Promise<ScriptSnapshot | null> {
    const current = await this.getScript(path);
    if (!current) {
      return null;
    }
    const key = pathKey(path);
    const history = this.scriptHistoryIndex[key] ?? [];
    for (let index = history.length - 2; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate || candidate.hash === current.hash && index === history.length - 1) {
        continue;
      }
      return this.getScriptVersion(path, candidate.hash);
    }
    return null;
  }

  async getUiRoot(path: string[]): Promise<UiNodeSnapshot | null> {
    const record = this.requireActive().uiRoots[pathKey(path)];
    if (!record) {
      return null;
    }
    const raw = await readFile(join(this.placeDir(), UI_DIR, record.treeFile), "utf-8");
    return sanitizeUiNode(JSON.parse(raw) as UiNodeSnapshot);
  }

  async getUiTree(path: string[], depth?: number): Promise<UiNodeSnapshot | null> {
    const active = this.requireActive();
    let matchedRoot: UiRootIndexRecord | null = null;
    for (const record of Object.values(active.uiRoots)) {
      if (pathStartsWith(path, record.path)) {
        if (!matchedRoot || record.path.length > matchedRoot.path.length) {
          matchedRoot = record;
        }
      }
    }
    if (!matchedRoot) {
      return null;
    }
    const root = await this.getUiRoot(matchedRoot.path);
    if (!root) {
      return null;
    }
    const node = findUiNode(root, path);
    if (!node) {
      return null;
    }
    if (typeof depth === "number" && Number.isFinite(depth)) {
      return limitUiDepth(node, Math.max(0, Math.trunc(depth)));
    }
    return cloneUiNode(node);
  }

  listScripts(options: ListScriptsOptions = {}): Array<Omit<ScriptSnapshot, "source">> {
    const active = this.requireActive();
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const query = options.query?.trim().toLowerCase();
    const service = options.service?.trim();

    const out: Array<Omit<ScriptSnapshot, "source">> = [];
    for (const record of Object.values(active.scripts)) {
      if (service && record.service !== service) {
        continue;
      }
      if (query) {
        const haystack = `${record.path.join("/")} ${record.name}`.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
      }
      out.push({
        path: record.path,
        service: record.service,
        name: record.name,
        className: record.className,
        hash: record.hash,
        updatedAt: record.updatedAt,
        draftAware: record.draftAware,
        readChannel: record.readChannel
      });
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  listUiRoots(options: ListUiRootsOptions = {}): Array<Omit<UiRootIndexRecord, "treeFile" | "key">> {
    const active = this.requireActive();
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const query = options.query?.trim().toLowerCase();
    const service = options.service?.trim();
    const out: Array<Omit<UiRootIndexRecord, "treeFile" | "key">> = [];

    for (const record of Object.values(active.uiRoots)) {
      if (service && record.service !== service) {
        continue;
      }
      if (query) {
        const haystack = `${record.path.join("/")} ${record.name} ${record.className}`.toLowerCase();
        if (!haystack.includes(query)) {
          continue;
        }
      }
      out.push({
        path: [...record.path],
        service: record.service,
        name: record.name,
        className: record.className,
        version: record.version,
        updatedAt: record.updatedAt
      });
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  isEmpty(): boolean {
    return Object.keys(this.requireActive().scripts).length === 0;
  }

  isUiEmpty(): boolean {
    return Object.keys(this.requireActive().uiRoots).length === 0;
  }

  scriptCount(): number {
    return Object.keys(this.requireActive().scripts).length;
  }

  uiRootCount(): number {
    return Object.keys(this.requireActive().uiRoots).length;
  }

  metadata(): {
    placeId: string;
    placeName: string;
    updatedAt: string;
    writeMode: "draft_only";
    editorApiAvailable: boolean | null;
    lastReadChannel: ScriptReadChannel | null;
    lastWriteChannel: ScriptWriteChannel | null;
    indexVersion: number | null;
    indexUpdatedAt: string | null;
    uiIndexVersion: number | null;
    uiIndexUpdatedAt: string | null;
  } | null {
    if (!this.activeIndex) {
      return null;
    }
    return {
      placeId: this.activeIndex.placeId,
      placeName: this.activeIndex.placeName,
      updatedAt: this.activeIndex.updatedAt,
      writeMode: this.activeIndex.writeMode,
      editorApiAvailable: this.activeIndex.editorApiAvailable,
      lastReadChannel: this.activeIndex.lastReadChannel,
      lastWriteChannel: this.activeIndex.lastWriteChannel,
      indexVersion: this.activeIndex.indexVersion,
      indexUpdatedAt: this.activeIndex.indexUpdatedAt,
      uiIndexVersion: this.activeIndex.uiIndexVersion,
      uiIndexUpdatedAt: this.activeIndex.uiIndexUpdatedAt
    };
  }

  getActivePlaceId(): string | null {
    return this.activeIndex?.placeId ?? null;
  }

  getActivePlaceDir(): string | null {
    return this.activeIndex ? this.placeDir() : null;
  }

  async listAllScriptsWithSource(): Promise<ScriptSnapshot[]> {
    const active = this.requireActive();
    const out: ScriptSnapshot[] = [];
    for (const record of Object.values(active.scripts)) {
      const source = await readFile(join(this.placeDir(), SCRIPTS_DIR, record.sourceFile), "utf-8");
      out.push({
        path: record.path,
        service: record.service,
        name: record.name,
        className: record.className,
        source,
        hash: record.hash,
        updatedAt: record.updatedAt,
        draftAware: record.draftAware,
        readChannel: record.readChannel
      });
    }
    return out;
  }

  async listAllUiRoots(): Promise<UiNodeSnapshot[]> {
    const active = this.requireActive();
    const out: UiNodeSnapshot[] = [];
    for (const record of Object.values(active.uiRoots)) {
      const raw = await readFile(join(this.placeDir(), UI_DIR, record.treeFile), "utf-8");
      out.push(sanitizeUiNode(JSON.parse(raw) as UiNodeSnapshot));
    }
    return out;
  }

  getChangedSince(cursorOrTimestamp: string, limitInput?: number): { cursor: string | null; items: ChangeJournalEntry[]; nextCursor: string | null } {
    const value = String(cursorOrTimestamp ?? "").trim();
    const limit = Math.max(1, Math.min(Math.trunc(limitInput ?? 250), 1000));
    if (!value) {
      const items = this.changeJournal.slice(0, limit);
      return {
        cursor: null,
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].cursor : this.changeJournal.length > 0 ? this.changeJournal[this.changeJournal.length - 1].cursor : null
      };
    }
    const numericCursor = Number.parseInt(value, 10);
    let items: ChangeJournalEntry[] = [];
    if (Number.isFinite(numericCursor) && String(numericCursor) === value) {
      items = this.changeJournal.filter((entry) => Number.parseInt(entry.cursor, 10) > numericCursor).slice(0, limit);
      return {
        cursor: value,
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].cursor : value
      };
    }
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) {
      items = this.changeJournal.filter((entry) => Date.parse(entry.time) > ts || Date.parse(entry.updatedAt) > ts).slice(0, limit);
      return {
        cursor: value,
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].cursor : null
      };
    }
    return {
      cursor: value,
      items: [],
      nextCursor: this.changeJournal.length > 0 ? this.changeJournal[this.changeJournal.length - 1].cursor : null
    };
  }

  async setEditorApiAvailable(value: boolean | null): Promise<void> {
    this.requireActive().editorApiAvailable = value;
    await this.saveIndex();
  }

  async setLastWriteChannel(channel: ScriptWriteChannel): Promise<void> {
    this.requireActive().lastWriteChannel = channel;
    await this.saveIndex();
  }

  async setIndexMetadata(version: number | null, updatedAt: string | null): Promise<void> {
    const active = this.requireActive();
    active.indexVersion = version;
    active.indexUpdatedAt = updatedAt;
    await this.saveIndex();
  }

  async setUiIndexMetadata(version: number | null, updatedAt: string | null): Promise<void> {
    const active = this.requireActive();
    active.uiIndexVersion = version;
    active.uiIndexUpdatedAt = updatedAt;
    await this.saveIndex();
  }

  async resetAll(): Promise<void> {
    await rm(join(this.cacheRoot, ".."), { recursive: true, force: true });
    this.activeIndex = null;
  }
}
