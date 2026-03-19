import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CacheStore } from "../cache/cacheStore.js";
import { UiNodeSnapshot } from "../domain/types.js";
import { normalizePath, pathKey, serviceFromPath } from "../lib/path.js";

const INDEX_VERSION = 1;
const INDEX_FILE = "ui-index.v1.json";

export interface UiSearchHit {
  path: string[];
  className: string;
  matchedProps: string[];
  score: number;
}

export interface UiSummaryItem {
  label: string;
  count: number;
}

export interface UiNodeHint {
  path: string[];
  className: string;
  reason: string;
  preview?: string;
}

export interface UiTreeSummary {
  path: string[];
  version: string;
  updatedAt: string;
  nodeCount: number;
  maxDepth: number;
  classHistogram: UiSummaryItem[];
  interactiveNodes: UiNodeHint[];
  textNodes: UiNodeHint[];
  layoutPrimitives: UiSummaryItem[];
}

interface PersistedUiIndex {
  version: number;
  updatedAt: string;
  placeId: string;
  roots: UiNodeSnapshot[];
}

function tokenize(input: string): string[] {
  const matches = input.toLowerCase().match(/[\p{L}\p{N}_-]+/gu);
  return matches ? matches.filter((part) => part.length > 0) : [];
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

function normalizeUiPrefix(path: unknown): string[] {
  if (!Array.isArray(path)) {
    throw new Error("rootPath must be an array");
  }
  const out = path
    .map((segment) => {
      if (typeof segment !== "string") {
        throw new Error("rootPath segments must be strings");
      }
      const trimmed = segment.trim();
      if (!trimmed) {
        throw new Error("rootPath segments must be non-empty");
      }
      return trimmed;
    })
    .filter(Boolean);
  if (out.length < 1) {
    throw new Error("rootPath must include at least a service");
  }
  return out;
}

function cloneNode(node: UiNodeSnapshot): UiNodeSnapshot {
  return {
    path: [...node.path],
    service: node.service,
    name: node.name,
    className: node.className,
    version: node.version,
    updatedAt: node.updatedAt,
    props: { ...node.props },
    tags: [...node.tags],
    attributes: { ...node.attributes },
    unsupportedProperties: [...node.unsupportedProperties],
    children: node.children.map((child) => cloneNode(child))
  };
}

function previewText(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function collectNodes(node: UiNodeSnapshot, into: UiNodeSnapshot[]): void {
  into.push(node);
  for (const child of node.children) {
    collectNodes(child, into);
  }
}

function scoreNode(node: UiNodeSnapshot, query: string, tokens: string[]): { score: number; matchedProps: string[] } {
  let score = 0;
  const matchedProps = new Set<string>();
  const pathText = node.path.join("/").toLowerCase();
  if (pathText.includes(query)) {
    score += 8;
    matchedProps.add("path");
  }
  if (node.className.toLowerCase().includes(query)) {
    score += 5;
    matchedProps.add("className");
  }
  if (node.name.toLowerCase().includes(query)) {
    score += 7;
    matchedProps.add("name");
  }

  for (const [propName, value] of Object.entries(node.props)) {
    if (typeof value === "string") {
      const text = value.toLowerCase();
      let localScore = 0;
      if (text.includes(query)) {
        localScore += 6;
      }
      for (const token of tokens) {
        if (text.includes(token)) {
          localScore += 2;
        }
      }
      if (localScore > 0) {
        score += localScore;
        matchedProps.add(propName);
      }
    }
  }

  return { score, matchedProps: [...matchedProps] };
}

export class UiRetrievalIndex {
  private readonly cache: CacheStore;
  private placeId: string | null = null;
  private roots = new Map<string, UiNodeSnapshot>();

  constructor(cache: CacheStore) {
    this.cache = cache;
  }

  async bootstrap(): Promise<void> {
    const meta = this.cache.metadata();
    if (!meta) {
      return;
    }
    await this.switchPlace(meta.placeId);
    if (this.roots.size === 0 && this.cache.uiRootCount() > 0) {
      await this.fullRebuildFromCache();
    }
  }

  async switchPlace(placeId: string): Promise<void> {
    if (this.placeId === placeId) {
      return;
    }
    this.placeId = placeId;
    this.roots.clear();
    await this.loadFromDisk();
  }

  async fullRebuildFromCache(): Promise<void> {
    const roots = await this.cache.listAllUiRoots();
    this.rebuildFromRoots(roots);
    await this.persist();
  }

  async upsertChangedRoots(paths: string[][]): Promise<void> {
    let changed = false;
    for (const path of paths) {
      const normalized = normalizePath(path);
      const key = pathKey(normalized);
      const root = await this.cache.getUiRoot(normalized);
      if (!root) {
        if (this.roots.delete(key)) {
          changed = true;
        }
        continue;
      }
      this.roots.set(key, cloneNode(root));
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  search(queryInput: string, options: { rootPath?: string[]; limit?: number } = {}): UiSearchHit[] {
    const query = String(queryInput ?? "").trim().toLowerCase();
    if (!query) {
      return [];
    }
    const tokens = tokenize(query);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const rootPath = options.rootPath ? normalizeUiPrefix(options.rootPath) : undefined;
    const hits: UiSearchHit[] = [];

    for (const root of this.roots.values()) {
      if (rootPath && !pathMatchesPrefix(root.path, rootPath) && !pathMatchesPrefix(rootPath, root.path)) {
        continue;
      }
      const nodes: UiNodeSnapshot[] = [];
      collectNodes(root, nodes);
      for (const node of nodes) {
        if (rootPath && !pathMatchesPrefix(node.path, rootPath)) {
          continue;
        }
        const { score, matchedProps } = scoreNode(node, query, tokens);
        if (score <= 0) {
          continue;
        }
        hits.push({
          path: [...node.path],
          className: node.className,
          matchedProps,
          score
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.path.join("/").localeCompare(b.path.join("/")));
    return hits.slice(0, limit);
  }

  rootCount(): number {
    return this.roots.size;
  }

  summarizeTree(pathInput: unknown): UiTreeSummary | null {
    const path = normalizePath(pathInput);
    const node = this.findNode(path);
    if (!node) {
      return null;
    }

    const classCounts = new Map<string, number>();
    const layoutCounts = new Map<string, number>();
    const interactiveNodes: UiNodeHint[] = [];
    const textNodes: UiNodeHint[] = [];
    let nodeCount = 0;
    let maxDepth = 0;

    const visit = (current: UiNodeSnapshot, depth: number): void => {
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, depth);
      classCounts.set(current.className, (classCounts.get(current.className) ?? 0) + 1);

      if (isInteractiveClass(current.className)) {
        interactiveNodes.push({
          path: [...current.path],
          className: current.className,
          reason: "interactive_class",
          preview: this.textPreview(current)
        });
      }

      const textPreview = this.textPreview(current);
      if (textPreview) {
        textNodes.push({
          path: [...current.path],
          className: current.className,
          reason: "text_like_props",
          preview: textPreview
        });
      }

      if (isLayoutPrimitive(current.className)) {
        layoutCounts.set(current.className, (layoutCounts.get(current.className) ?? 0) + 1);
      }

      for (const child of current.children) {
        visit(child, depth + 1);
      }
    };

    visit(node, 0);

    return {
      path: [...node.path],
      version: node.version,
      updatedAt: node.updatedAt,
      nodeCount,
      maxDepth,
      classHistogram: this.mapToSummaryItems(classCounts),
      interactiveNodes: interactiveNodes
        .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
        .slice(0, 20),
      textNodes: textNodes
        .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
        .slice(0, 20),
      layoutPrimitives: this.mapToSummaryItems(layoutCounts)
    };
  }

  private rebuildFromRoots(roots: UiNodeSnapshot[]): void {
    this.roots.clear();
    for (const root of roots) {
      this.roots.set(pathKey(root.path), cloneNode(root));
    }
  }

  private indexFilePath(): string | null {
    const placeDir = this.cache.getActivePlaceDir();
    if (!placeDir) {
      return null;
    }
    return join(placeDir, INDEX_FILE);
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = this.indexFilePath();
    if (!filePath) {
      return;
    }
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedUiIndex>;
      if (parsed.version !== INDEX_VERSION || parsed.placeId !== this.placeId || !Array.isArray(parsed.roots)) {
        return;
      }
      this.rebuildFromRoots(
        parsed.roots.map((root) => ({
          ...root,
          path: Array.isArray(root.path) ? root.path.map((segment) => String(segment)) : [],
          service: typeof root.service === "string" ? root.service : serviceFromPath(root.path ?? []),
          name: typeof root.name === "string" ? root.name : String(root.path?.[root.path.length - 1] ?? "Unknown"),
          className: typeof root.className === "string" ? root.className : "LayerCollector",
          version: String(root.version ?? ""),
          updatedAt: String(root.updatedAt ?? new Date().toISOString()),
          props: typeof root.props === "object" && root.props ? { ...root.props } : {},
          unsupportedProperties: Array.isArray(root.unsupportedProperties)
            ? root.unsupportedProperties.map((item) => String(item))
            : [],
          children: Array.isArray(root.children) ? root.children : []
        }))
      );
    } catch {
      // malformed persisted index is ignored
    }
  }

  private async persist(): Promise<void> {
    const filePath = this.indexFilePath();
    if (!filePath || !this.placeId) {
      return;
    }
    const payload: PersistedUiIndex = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      placeId: this.placeId,
      roots: [...this.roots.values()].map((root) => cloneNode(root))
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    await this.cache.setUiIndexMetadata(INDEX_VERSION, payload.updatedAt);
  }

  private findNode(path: string[]): UiNodeSnapshot | null {
    let bestRoot: UiNodeSnapshot | null = null;
    for (const root of this.roots.values()) {
      if (pathMatchesPrefix(path, root.path)) {
        if (!bestRoot || root.path.length > bestRoot.path.length) {
          bestRoot = root;
        }
      }
    }
    if (!bestRoot) {
      return null;
    }
    return this.findNodeRecursive(bestRoot, path);
  }

  private findNodeRecursive(node: UiNodeSnapshot, path: string[]): UiNodeSnapshot | null {
    if (pathKey(node.path) === pathKey(path)) {
      return cloneNode(node);
    }
    for (const child of node.children) {
      const found = this.findNodeRecursive(child, path);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private textPreview(node: UiNodeSnapshot): string | undefined {
    const candidates = ["Text", "PlaceholderText", "Image", "Name"];
    for (const prop of candidates) {
      const value = node.props[prop];
      if (typeof value === "string" && value.trim()) {
        return previewText(value);
      }
    }
    return undefined;
  }

  private mapToSummaryItems(map: Map<string, number>): UiSummaryItem[] {
    return [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
}

function isInteractiveClass(className: string): boolean {
  return new Set([
    "TextButton",
    "ImageButton",
    "TextBox",
    "ScrollingFrame",
    "ViewportFrame",
    "VideoFrame"
  ]).has(className);
}

function isLayoutPrimitive(className: string): boolean {
  return new Set([
    "UIListLayout",
    "UIGridLayout",
    "UIPageLayout",
    "UITableLayout",
    "UIFlexItem",
    "UIPadding",
    "UICorner",
    "UIStroke",
    "UIGradient",
    "UIScale",
    "UIAspectRatioConstraint",
    "UISizeConstraint",
    "UITextSizeConstraint"
  ]).has(className);
}
