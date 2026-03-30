// @ts-nocheck
import { UiRetrievalIndex } from "../indexer/uiRetrievalIndex.js";
import { RetrievalIndex } from "../indexer/retrievalIndex.js";
import { BridgeError } from "../lib/errors.js";
import { normalizeSource, sourceHash } from "../lib/hash.js";
import { normalizePath, pathKey } from "../lib/path.js";
import { applyScriptPatch, diffLines, validateScriptPatchOps } from "../lib/scriptPatch.js";
import { resolveSourcePayload } from "../lib/sourcePayload.js";
import { CommandQueue } from "./commandQueue.js";
import { explainBridgeError, recommendedNextStepByError } from "./errorGuidance.js";
import { RequestTraceStore } from "./requestTraceStore.js";
import { SessionRegistry } from "./sessionRegistry.js";
function nowMs() {
    return Date.now();
}
function toBool(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value !== "string") {
        return fallback;
    }
    return value === "1" || value.toLowerCase() === "true";
}
const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
const READ_CHANNELS = new Set(["editor", "unknown"]);
const LOG_LEVELS = new Set(["info", "warn", "error"]);
const DEFAULT_READ_MAX_AGE_MS = 5_000;
const LOG_BUFFER_LIMIT = 1_000;
const MAX_STUDIO_POLL_WAIT_MS = 100;
const WRITE_VERIFY_MAX_BYTES = 256 * 1024;
const SESSION_STALE_AFTER_MS = 15_000;
const COMMAND_TIMEOUTS_MS = {
    default: 15_000,
    snapshot_all_scripts: 90_000,
    snapshot_script_by_path: 30_000,
    snapshot_scripts_by_paths: 60_000,
    set_script_source_if_hash: 45_000,
    upsert_script: 45_000,
    delete_script_if_hash: 45_000,
    move_script_if_hash: 45_000,
    snapshot_ui_roots: 90_000,
    snapshot_ui_subtree_by_path: 30_000,
    snapshot_ui_layout_by_path: 30_000,
    mutate_ui_batch_if_version: 45_000
};
function toScriptClass(input) {
    if (typeof input !== "string" || !SCRIPT_CLASSES.has(input)) {
        throw new BridgeError("invalid_class", "class must be Script | LocalScript | ModuleScript", 400);
    }
    return input;
}
function toReadChannel(input) {
    if (typeof input !== "string" || !READ_CHANNELS.has(input)) {
        return "unknown";
    }
    return input;
}
function toWriteChannel(input) {
    return input === "editor" ? "editor" : null;
}
function decodeSource(input, inputBase64) {
    return resolveSourcePayload(input, inputBase64, "source", "sourceBase64");
}
function nowIso() {
    return new Date().toISOString();
}
function sessionAgeMs(session) {
    const seenAtMs = typeof session?.lastSeenAt === "string" ? Date.parse(session.lastSeenAt) : Number.NaN;
    return Number.isFinite(seenAtMs) ? Math.max(0, nowMs() - seenAtMs) : Number.POSITIVE_INFINITY;
}
function sourceLineCount(source) {
    const normalized = normalizeSource(typeof source === "string" ? source : "");
    if (normalized.length === 0) {
        return 1;
    }
    return normalized.split("\n").length;
}
function compactSourcePreview(source, maxLength = 120) {
    const normalized = normalizeSource(typeof source === "string" ? source : "");
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
function shouldVerifyScriptWrite(source) {
    if (typeof source !== "string") {
        return false;
    }
    if (Buffer.byteLength(source, "utf8") > WRITE_VERIFY_MAX_BYTES) {
        return false;
    }
    return source.includes("\n") || source.includes("\r");
}
function buildWriteVerificationError(path, expectedSource, actualSource) {
    return new BridgeError("write_verification_failed", `Written script content differed after save: ${path.join("/")}`, 409, {
        path,
        expectedHash: sourceHash(expectedSource),
        currentHash: sourceHash(actualSource),
        expectedLineCount: sourceLineCount(expectedSource),
        currentLineCount: sourceLineCount(actualSource),
        expectedPreview: compactSourcePreview(expectedSource),
        currentPreview: compactSourcePreview(actualSource)
    });
}
function buildWriteExpectationDetails(source, className = null) {
    return {
        expectedHash: sourceHash(source),
        expectedLineCount: sourceLineCount(source),
        expectedPreview: compactSourcePreview(source),
        expectedClassName: className
    };
}
function heavyOperationPolicy() {
    return {
        maxSyncWaitMs: 30_000,
        heavyOperations: [
            "create_script",
            "update_script",
            "apply_script_patch",
            "apply_ui_batch",
            "apply_ui_template",
            "get_project_summary"
        ],
        guidance: "For heavy operations, do not wait longer than 30 seconds. Use requestId with get_request_trace or get_logs if the write is still pending."
    };
}
function compactText(input, maxLength = 120) {
    const text = String(input ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
function levelPriority(level) {
    if (level === "error") {
        return 3;
    }
    if (level === "warn") {
        return 2;
    }
    return 1;
}
function normalizeTagList(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    const seen = new Set();
    const out = [];
    for (const entry of input) {
        const value = String(entry ?? "").trim();
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}
function normalizeAttributesMap(input) {
    return typeof input === "object" && input ? { ...input } : {};
}
function normalizeMetadataTagPatch(currentTags, metadata) {
    const fullReplacement = normalizeTagList(metadata?.tags);
    if (fullReplacement.length > 0 || Array.isArray(metadata?.tags)) {
        const current = new Set(normalizeTagList(currentTags));
        const next = new Set(fullReplacement);
        return {
            addTags: fullReplacement.filter((tag) => !current.has(tag)),
            removeTags: [...current].filter((tag) => !next.has(tag)),
            expectedTags: [...fullReplacement].sort()
        };
    }
    return {
        addTags: normalizeTagList(metadata?.addTags),
        removeTags: normalizeTagList(metadata?.removeTags),
        expectedTags: applyMetadataPatchToTags(currentTags, metadata)
    };
}
function applyMetadataPatchToTags(currentTags, metadata) {
    const next = new Set(normalizeTagList(currentTags));
    for (const tag of normalizeTagList(metadata?.addTags)) {
        next.add(tag);
    }
    for (const tag of normalizeTagList(metadata?.removeTags)) {
        next.delete(tag);
    }
    return [...next].sort();
}
function applyMetadataPatchToAttributes(currentAttributes, metadata) {
    const next = normalizeAttributesMap(currentAttributes);
    const updates = normalizeAttributesMap(metadata?.attributes);
    for (const [key, value] of Object.entries(updates)) {
        next[key] = value;
    }
    const clearList = Array.isArray(metadata?.clearAttributes) ? metadata.clearAttributes.map((entry) => String(entry)) : [];
    for (const key of clearList) {
        delete next[key];
    }
    return next;
}
function stableJson(value) {
    return JSON.stringify(value, (_key, current) => {
        if (Array.isArray(current)) {
            return current;
        }
        if (current && typeof current === "object") {
            return Object.keys(current)
                .sort()
                .reduce((out, key) => {
                out[key] = current[key];
                return out;
            }, {});
        }
        return current;
    });
}
function sameMetadataAttributes(left, right) {
    return stableJson(normalizeAttributesMap(left)) === stableJson(normalizeAttributesMap(right));
}
function buildMetadataVerificationError(kind, path, expectedTags, actualTags, expectedAttributes, actualAttributes) {
    return new BridgeError("metadata_verification_failed", `${kind} metadata differed after save: ${path.join("/")}`, 409, {
        path,
        expectedTags,
        actualTags,
        expectedAttributes,
        actualAttributes
    });
}
function cloneUiNode(node) {
    return {
        path: [...node.path],
        service: node.service,
        name: node.name,
        className: node.className,
        version: node.version,
        updatedAt: node.updatedAt,
        props: { ...node.props },
        tags: [...(node.tags ?? [])],
        attributes: { ...(node.attributes ?? {}) },
        unsupportedProperties: [...node.unsupportedProperties],
        children: node.children.map((child) => cloneUiNode(child))
    };
}
function findUiNodeByPath(node, targetPath) {
    if (pathKey(node.path) === pathKey(targetPath)) {
        return node;
    }
    for (const child of node.children) {
        const found = findUiNodeByPath(child, targetPath);
        if (found) {
            return found;
        }
    }
    return null;
}
function sanitizeUiNodePayload(input) {
    if (!input || typeof input !== "object") {
        throw new BridgeError("invalid_ui_root", "UI root must be an object", 400);
    }
    const value = input;
    const path = normalizePath(value.path);
    if (path.length < 2) {
        throw new BridgeError("invalid_ui_root", "UI root path must contain at least 2 segments", 400);
    }
    const children = Array.isArray(value.children) ? value.children.map((child) => sanitizeUiNodePayload(child)) : [];
    return {
        path,
        service: typeof value.service === "string" ? value.service : path[0],
        name: typeof value.name === "string" ? value.name : path[path.length - 1],
        className: typeof value.className === "string" ? value.className : "LayerCollector",
        version: typeof value.version === "string" ? value.version : "",
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
        props: typeof value.props === "object" && value.props ? { ...value.props } : {},
        tags: normalizeTagList(value.tags),
        attributes: normalizeAttributesMap(value.attributes),
        unsupportedProperties: Array.isArray(value.unsupportedProperties) ? value.unsupportedProperties.map((entry) => String(entry)) : [],
        children
    };
}
function pathStartsWithPrefix(path, prefix) {
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
function cloneUiOpsFromSubtree(sourceNode, newParentPath, newName) {
    const operations = [];
    const visit = (node, parentPath, index, overrideName) => {
        const name = overrideName ?? node.name;
        const nextPath = [...parentPath, name];
        operations.push({
            op: "create_node",
            parentPath,
            className: node.className,
            name,
            props: { ...node.props },
            tags: [...(node.tags ?? [])],
            attributes: { ...(node.attributes ?? {}) },
            index
        });
        node.children.forEach((child, childIndex) => visit(child, nextPath, childIndex));
    };
    visit(sourceNode, newParentPath, undefined, newName);
    return operations;
}
function normalizeParentPathInput(pathInput) {
    if (!Array.isArray(pathInput)) {
        throw new Error("path must be an array");
    }
    const out = pathInput
        .map((segment) => {
        if (typeof segment !== "string") {
            throw new Error("path segments must be strings");
        }
        const trimmed = segment.trim();
        if (!trimmed) {
            throw new Error("path segments must be non-empty");
        }
        return trimmed;
    })
        .filter(Boolean);
    if (out.length < 1) {
        throw new Error("path must include at least a service");
    }
    return out;
}
function defaultModalSize() {
    return {
        type: "UDim2",
        x: { type: "UDim", scale: 0.42, offset: 0 },
        y: { type: "UDim", scale: 0.36, offset: 0 }
    };
}
function compileModalTemplate(targetPath, options) {
    const rootPath = [...targetPath, options.name];
    const ops = [
        {
            op: "create_node",
            parentPath: targetPath,
            className: "Frame",
            name: options.name,
            props: {
                AnchorPoint: { type: "Vector2", x: 0.5, y: 0.5 },
                Position: {
                    type: "UDim2",
                    x: { type: "UDim", scale: 0.5, offset: 0 },
                    y: { type: "UDim", scale: 0.5, offset: 0 }
                },
                Size: options.size ?? defaultModalSize(),
                BackgroundTransparency: 0.08,
                BorderSizePixel: 0
            }
        },
        { op: "create_node", parentPath: rootPath, className: "UICorner", name: `${options.name}_Corner`, props: {} },
        { op: "create_node", parentPath: rootPath, className: "UIStroke", name: `${options.name}_Stroke`, props: { Thickness: 1 } },
        {
            op: "create_node",
            parentPath: rootPath,
            className: "TextLabel",
            name: `${options.name}_TitleLabel`,
            props: {
                Text: options.title,
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 0, offset: 36 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 16 }, y: { type: "UDim", scale: 0, offset: 12 } }
            }
        },
        {
            op: "create_node",
            parentPath: rootPath,
            className: "TextLabel",
            name: `${options.name}_BodyLabel`,
            props: {
                Text: options.bodyText ?? "",
                BackgroundTransparency: 1,
                TextWrapped: true,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 1, offset: -110 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 16 }, y: { type: "UDim", scale: 0, offset: 52 } }
            }
        },
        {
            op: "create_node",
            parentPath: rootPath,
            className: "Frame",
            name: `${options.name}_ButtonsRow`,
            props: {
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 0, offset: 40 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 16 }, y: { type: "UDim", scale: 1, offset: -56 } }
            }
        },
        {
            op: "create_node",
            parentPath: [...rootPath, `${options.name}_ButtonsRow`],
            className: "UIListLayout",
            name: `${options.name}_ButtonsLayout`,
            props: {
                FillDirection: { type: "Enum", enumType: "FillDirection", value: "Horizontal" },
                HorizontalAlignment: { type: "Enum", enumType: "HorizontalAlignment", value: "Right" },
                VerticalAlignment: { type: "Enum", enumType: "VerticalAlignment", value: "Center" }
            }
        },
        {
            op: "create_node",
            parentPath: [...rootPath, `${options.name}_ButtonsRow`],
            className: "TextButton",
            name: `${options.name}_CancelButton`,
            props: {
                Text: options.cancelText ?? "Cancel",
                Size: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 120 }, y: { type: "UDim", scale: 1, offset: 0 } }
            }
        },
        {
            op: "create_node",
            parentPath: [...rootPath, `${options.name}_ButtonsRow`],
            className: "TextButton",
            name: `${options.name}_ConfirmButton`,
            props: {
                Text: options.confirmText ?? "Confirm",
                Size: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 120 }, y: { type: "UDim", scale: 1, offset: 0 } }
            }
        }
    ];
    if (options.showCloseButton !== false) {
        ops.push({
            op: "create_node",
            parentPath: rootPath,
            className: "TextButton",
            name: `${options.name}_CloseButton`,
            props: {
                Text: "X",
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 24 }, y: { type: "UDim", scale: 0, offset: 24 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 0, offset: 12 } }
            }
        });
    }
    return ops;
}
function compileShopGridTemplate(targetPath, options) {
    const columns = Number.isFinite(options.columns) ? Math.max(1, Math.min(6, Math.trunc(options.columns))) : 3;
    const sampleItems = Array.isArray(options.sampleItems) ? options.sampleItems : [];
    const rootPath = [...targetPath, options.name];
    const ops = [
        {
            op: "create_node",
            parentPath: targetPath,
            className: "Frame",
            name: options.name,
            props: {
                BackgroundTransparency: 0.05,
                BorderSizePixel: 0,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: 0 }, y: { type: "UDim", scale: 1, offset: 0 } }
            }
        },
        {
            op: "create_node",
            parentPath: rootPath,
            className: "TextLabel",
            name: `${options.name}_TitleLabel`,
            props: {
                Text: options.title,
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 0, offset: 36 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 16 }, y: { type: "UDim", scale: 0, offset: 12 } }
            }
        },
        {
            op: "create_node",
            parentPath: rootPath,
            className: "Frame",
            name: `${options.name}_GridHost`,
            props: {
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -32 }, y: { type: "UDim", scale: 1, offset: -64 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 16 }, y: { type: "UDim", scale: 0, offset: 52 } }
            }
        },
        {
            op: "create_node",
            parentPath: [...rootPath, `${options.name}_GridHost`],
            className: "UIGridLayout",
            name: `${options.name}_GridLayout`,
            props: {
                FillDirectionMaxCells: columns,
                CellPadding: {
                    type: "UDim2",
                    x: { type: "UDim", scale: 0.02, offset: 0 },
                    y: { type: "UDim", scale: 0.02, offset: 0 }
                },
                CellSize: {
                    type: "UDim2",
                    x: { type: "UDim", scale: 1 / columns - 0.02, offset: 0 },
                    y: { type: "UDim", scale: 0, offset: 140 }
                }
            }
        }
    ];
    sampleItems.forEach((item, index) => {
        const cardName = `${options.name}_Card${String(index + 1).padStart(2, "0")}`;
        const cardPath = [...rootPath, `${options.name}_GridHost`, cardName];
        ops.push({ op: "create_node", parentPath: [...rootPath, `${options.name}_GridHost`], className: "Frame", name: cardName, props: { BorderSizePixel: 0 } });
        if (Number.isFinite(options.cardAspectRatio)) {
            ops.push({
                op: "create_node",
                parentPath: cardPath,
                className: "UIAspectRatioConstraint",
                name: `${cardName}_AspectRatio`,
                props: { AspectRatio: options.cardAspectRatio }
            });
        }
        ops.push({
            op: "create_node",
            parentPath: cardPath,
            className: "TextLabel",
            name: `${cardName}_NameLabel`,
            props: {
                Text: item.name,
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -16 }, y: { type: "UDim", scale: 0, offset: 28 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 8 }, y: { type: "UDim", scale: 0, offset: 8 } }
            }
        });
        ops.push({
            op: "create_node",
            parentPath: cardPath,
            className: "TextLabel",
            name: `${cardName}_PriceLabel`,
            props: {
                Text: item.priceText ?? "",
                BackgroundTransparency: 1,
                Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -16 }, y: { type: "UDim", scale: 0, offset: 24 } },
                Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 8 }, y: { type: "UDim", scale: 1, offset: -56 } }
            }
        });
        if (options.showPurchaseButton !== false) {
            ops.push({
                op: "create_node",
                parentPath: cardPath,
                className: "TextButton",
                name: `${cardName}_PurchaseButton`,
                props: {
                    Text: "Buy",
                    Size: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -16 }, y: { type: "UDim", scale: 0, offset: 28 } },
                    Position: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 8 }, y: { type: "UDim", scale: 1, offset: -32 } }
                }
            });
        }
        if (item.badgeText) {
            ops.push({
                op: "create_node",
                parentPath: cardPath,
                className: "TextLabel",
                name: `${cardName}_BadgeLabel`,
                props: {
                    Text: item.badgeText,
                    BackgroundTransparency: 1,
                    Size: { type: "UDim2", x: { type: "UDim", scale: 0, offset: 72 }, y: { type: "UDim", scale: 0, offset: 24 } },
                    Position: { type: "UDim2", x: { type: "UDim", scale: 1, offset: -80 }, y: { type: "UDim", scale: 0, offset: 8 } }
                }
            });
        }
    });
    return ops;
}
function normalizeUiBatchOperation(input) {
    if (!input || typeof input !== "object") {
        throw new BridgeError("invalid_ui_operation", "UI operation must be an object", 400);
    }
    const value = input;
    const op = typeof value.op === "string" ? value.op : "";
    if (op === "update_props") {
        const hasPath = value.path !== undefined;
        const hasPathRef = typeof value.pathRef === "string" && value.pathRef.trim().length > 0;
        if (hasPath === hasPathRef) {
            throw new BridgeError("invalid_ui_operation", "update_props requires exactly one of path or pathRef", 400);
        }
        return {
            op,
            path: hasPath ? normalizePath(value.path) : undefined,
            pathRef: hasPathRef ? value.pathRef.trim() : undefined,
            props: typeof value.props === "object" && value.props ? { ...value.props } : {},
            clearProps: Array.isArray(value.clearProps) ? value.clearProps.map((entry) => String(entry)) : []
        };
    }
    if (op === "update_metadata") {
        const hasPath = value.path !== undefined;
        const hasPathRef = typeof value.pathRef === "string" && value.pathRef.trim().length > 0;
        if (hasPath === hasPathRef) {
            throw new BridgeError("invalid_ui_operation", "update_metadata requires exactly one of path or pathRef", 400);
        }
        return {
            op,
            path: hasPath ? normalizePath(value.path) : undefined,
            pathRef: hasPathRef ? value.pathRef.trim() : undefined,
            addTags: normalizeTagList(value.addTags),
            removeTags: normalizeTagList(value.removeTags),
            attributes: normalizeAttributesMap(value.attributes),
            clearAttributes: Array.isArray(value.clearAttributes) ? value.clearAttributes.map((entry) => String(entry)) : []
        };
    }
    if (op === "create_node") {
        if (typeof value.className !== "string" || typeof value.name !== "string" || value.name.trim() === "") {
            throw new BridgeError("invalid_ui_operation", "create_node requires className and name", 400);
        }
        const hasParentPath = value.parentPath !== undefined;
        const hasParentRef = typeof value.parentRef === "string" && value.parentRef.trim().length > 0;
        if (hasParentPath === hasParentRef) {
            throw new BridgeError("invalid_ui_operation", "create_node requires exactly one of parentPath or parentRef", 400);
        }
        return {
            op,
            parentPath: hasParentPath ? normalizePath(value.parentPath) : undefined,
            parentRef: hasParentRef ? value.parentRef.trim() : undefined,
            className: value.className,
            name: value.name,
            props: typeof value.props === "object" && value.props ? { ...value.props } : {},
            tags: normalizeTagList(value.tags),
            attributes: normalizeAttributesMap(value.attributes),
            index: typeof value.index === "number" && Number.isFinite(value.index) ? Math.max(0, Math.trunc(value.index)) : undefined,
            id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined
        };
    }
    if (op === "delete_node") {
        const hasPath = value.path !== undefined;
        const hasPathRef = typeof value.pathRef === "string" && value.pathRef.trim().length > 0;
        if (hasPath === hasPathRef) {
            throw new BridgeError("invalid_ui_operation", "delete_node requires exactly one of path or pathRef", 400);
        }
        return {
            op,
            path: hasPath ? normalizePath(value.path) : undefined,
            pathRef: hasPathRef ? value.pathRef.trim() : undefined
        };
    }
    if (op === "move_node") {
        const hasPath = value.path !== undefined;
        const hasPathRef = typeof value.pathRef === "string" && value.pathRef.trim().length > 0;
        const hasParentPath = value.newParentPath !== undefined;
        const hasParentRef = typeof value.newParentRef === "string" && value.newParentRef.trim().length > 0;
        if (hasPath === hasPathRef) {
            throw new BridgeError("invalid_ui_operation", "move_node requires exactly one of path or pathRef", 400);
        }
        if (hasParentPath === hasParentRef) {
            throw new BridgeError("invalid_ui_operation", "move_node requires exactly one of newParentPath or newParentRef", 400);
        }
        return {
            op,
            path: hasPath ? normalizePath(value.path) : undefined,
            pathRef: hasPathRef ? value.pathRef.trim() : undefined,
            newParentPath: hasParentPath ? normalizePath(value.newParentPath) : undefined,
            newParentRef: hasParentRef ? value.newParentRef.trim() : undefined,
            index: typeof value.index === "number" && Number.isFinite(value.index) ? Math.max(0, Math.trunc(value.index)) : undefined
        };
    }
    throw new BridgeError("invalid_ui_operation", `Unsupported UI operation: ${op}`, 400);
}
function ensureUiOperationWithinRoot(rootPath, operation) {
    if (operation.op === "create_node") {
        if (operation.parentPath && !pathStartsWithPrefix(operation.parentPath, rootPath)) {
            throw new BridgeError("ui_operation_out_of_root", "create_node parentPath must stay inside rootPath", 400, {
                rootPath,
                parentPath: operation.parentPath
            });
        }
        return;
    }
    if (operation.path && !pathStartsWithPrefix(operation.path, rootPath)) {
        throw new BridgeError("ui_operation_out_of_root", `${operation.op} path must stay inside rootPath`, 400, {
            rootPath,
            path: operation.path
        });
    }
    if (operation.op === "move_node" && operation.newParentPath && !pathStartsWithPrefix(operation.newParentPath, rootPath)) {
        throw new BridgeError("ui_operation_out_of_root", "move_node newParentPath must stay inside rootPath", 400, {
            rootPath,
            newParentPath: operation.newParentPath
        });
    }
}
function resolveUiOperationRefs(rootPath, operations) {
    const resolvedRefs = {};
    const resolved = [];
    const refs = new Map();
    const resolvePathValue = (label, pathValue, pathRef) => {
        if (pathValue && pathRef) {
            throw new BridgeError("invalid_ui_operation", `${label} cannot include both path and pathRef`, 400);
        }
        if (pathRef) {
            const match = refs.get(pathRef);
            if (!match) {
                throw new BridgeError("invalid_ui_operation", `${label} references unknown id: ${pathRef}`, 400, { pathRef });
            }
            return [...match];
        }
        if (pathValue) {
            return [...pathValue];
        }
        throw new BridgeError("invalid_ui_operation", `${label} requires a path or pathRef`, 400);
    };
    for (const operation of operations) {
        if (operation.op === "create_node") {
            const parentPath = resolvePathValue("create_node parent", operation.parentPath, operation.parentRef);
            const concrete = {
                op: "create_node",
                parentPath,
                className: operation.className,
                name: operation.name,
                props: operation.props ?? {},
                index: operation.index
            };
            ensureUiOperationWithinRoot(rootPath, concrete);
            resolved.push(concrete);
            if (operation.id) {
                if (refs.has(operation.id)) {
                    throw new BridgeError("invalid_ui_operation", `Duplicate UI ref id: ${operation.id}`, 400, { id: operation.id });
                }
                const createdPath = [...parentPath, operation.name];
                refs.set(operation.id, createdPath);
                resolvedRefs[operation.id] = createdPath;
            }
            continue;
        }
        if (operation.op === "update_props") {
            const path = resolvePathValue("update_props target", operation.path, operation.pathRef);
            const concrete = {
                op: "update_props",
                path,
                props: operation.props ?? {},
                clearProps: operation.clearProps ?? []
            };
            ensureUiOperationWithinRoot(rootPath, concrete);
            resolved.push(concrete);
            continue;
        }
        if (operation.op === "update_metadata") {
            const path = resolvePathValue("update_metadata target", operation.path, operation.pathRef);
            const concrete = {
                op: "update_metadata",
                path,
                addTags: operation.addTags ?? [],
                removeTags: operation.removeTags ?? [],
                attributes: operation.attributes ?? {},
                clearAttributes: operation.clearAttributes ?? []
            };
            ensureUiOperationWithinRoot(rootPath, concrete);
            resolved.push(concrete);
            continue;
        }
        if (operation.op === "delete_node") {
            const path = resolvePathValue("delete_node target", operation.path, operation.pathRef);
            const concrete = { op: "delete_node", path };
            ensureUiOperationWithinRoot(rootPath, concrete);
            resolved.push(concrete);
            continue;
        }
        if (operation.op === "move_node") {
            const path = resolvePathValue("move_node target", operation.path, operation.pathRef);
            const newParentPath = resolvePathValue("move_node newParent", operation.newParentPath, operation.newParentRef);
            const concrete = {
                op: "move_node",
                path,
                newParentPath,
                index: operation.index
            };
            ensureUiOperationWithinRoot(rootPath, concrete);
            resolved.push(concrete);
            continue;
        }
        throw new BridgeError("invalid_ui_operation", `Unsupported UI operation: ${operation.op}`, 400);
    }
    return { operations: resolved, resolvedRefs };
}
function flattenLayoutNode(node, depth = 0, parentPath = null, into = []) {
    const nodeFamily = classifyLayoutNodeFamily(node.className);
    into.push({
        path: [...node.path],
        className: node.className,
        nodeFamily,
        visible: node.visible !== false,
        active: node.active === true,
        anchorPoint: node.anchorPoint ?? { x: 0, y: 0 },
        position: node.position ?? null,
        size: node.size ?? null,
        absolutePosition: node.absolutePosition ?? { x: 0, y: 0 },
        absoluteSize: node.absoluteSize ?? { x: 0, y: 0 },
        zIndex: typeof node.zIndex === "number" ? node.zIndex : 0,
        clipsDescendants: node.clipsDescendants === true,
        text: typeof node.text === "string" ? node.text : undefined,
        textBounds: node.textBounds ?? undefined,
        textScaled: node.textScaled === true,
        textWrapped: node.textWrapped === true,
        depth,
        parentPath
    });
    for (const child of node.children ?? []) {
        flattenLayoutNode(child, depth + 1, [...node.path], into);
    }
    return into;
}
function classifyLayoutNodeFamily(className) {
    if (/^(Frame|TextLabel|TextButton|ImageLabel|ImageButton|ScrollingFrame|ViewportFrame|VideoFrame|CanvasGroup)$/.test(className)) {
        return "renderable";
    }
    if (/^(UICorner|UIStroke|UIGradient)$/.test(className)) {
        return "decorator";
    }
    if (/^(UIListLayout|UIGridLayout|UIPageLayout|UITableLayout|UIPadding|UIFlexItem|UIScale)$/.test(className)) {
        return "layout_helper";
    }
    if (/^(UIAspectRatioConstraint|UITextSizeConstraint|UISizeConstraint|UIConstraint)$/.test(className)) {
        return "constraint";
    }
    return "renderable";
}
function issueRank(issue) {
    const severityWeight = issue.severity === "warn" ? 3 : issue.severity === "info" ? 2 : 1;
    const codeWeight = issue.code === "overlap" || issue.code === "hidden_interactive"
        ? 3
        : issue.code === "offscreen" || issue.code === "zero_size"
            ? 2
            : 1;
    return severityWeight * 10 + codeWeight;
}
function validateLayoutSnapshot(snapshot) {
    const issues = [];
    const nodes = flattenLayoutNode(snapshot.root);
    const nodeMap = new Map(nodes.map((node) => [pathKey(node.path), node]));
    const rootRect = makeRect(nodes[0]);
    const screenSpace = snapshot.screenSpace === true;
    let suppressedHelperChecks = 0;
    if (!screenSpace) {
        issues.push({
            code: "partial_geometry_only",
            path: snapshot.root.path,
            severity: "info",
            message: "Geometry diagnostics are partial for non-screen-space UI."
        });
    }
    for (const node of nodes) {
        const renderable = node.nodeFamily === "renderable";
        const rect = makeRect(node);
        if (!renderable) {
            suppressedHelperChecks += 1;
        }
        if (renderable && (node.absoluteSize.x <= 0 || node.absoluteSize.y <= 0)) {
            issues.push({ code: "zero_size", path: node.path, severity: "warn", message: "Node has zero-sized geometry." });
        }
        if (renderable && screenSpace && node.visible !== false && node.depth > 0) {
            if (rect.right <= rootRect.left || rect.left >= rootRect.right || rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) {
                issues.push({ code: "offscreen", path: node.path, severity: "warn", message: "Node appears fully outside the root bounds." });
            }
        }
        if (renderable && looksInteractive(node.className) && (node.visible === false || node.absoluteSize.x <= 0 || node.absoluteSize.y <= 0)) {
            issues.push({ code: "hidden_interactive", path: node.path, severity: "warn", message: "Interactive control is hidden or has unusable geometry." });
        }
        if (renderable && looksTextLike(node.className) && node.textBounds && node.absoluteSize) {
            if (node.textScaled !== true && (node.textBounds.x > node.absoluteSize.x || node.textBounds.y > node.absoluteSize.y) && !node.textWrapped) {
                issues.push({ code: "text_overflow_risk", path: node.path, severity: "info", message: "Text bounds exceed control bounds." });
            }
        }
        if (renderable && node.parentPath) {
            const parent = nodeMap.get(pathKey(node.parentPath));
            if (parent?.clipsDescendants) {
                const parentRect = makeRect(parent);
                if (rect.left < parentRect.left || rect.top < parentRect.top || rect.right > parentRect.right || rect.bottom > parentRect.bottom) {
                    issues.push({ code: "clipped_by_parent", path: node.path, severity: "info", message: "Node extends beyond a clipping parent." });
                }
            }
        }
    }
    const siblingsByParent = new Map();
    for (const node of nodes) {
        if (!node.parentPath || !node.visible || node.absoluteSize.x <= 0 || node.absoluteSize.y <= 0) {
            continue;
        }
        const parentKey = pathKey(node.parentPath);
        const entries = siblingsByParent.get(parentKey) ?? [];
        entries.push(node);
        siblingsByParent.set(parentKey, entries);
    }
    for (const entries of siblingsByParent.values()) {
        const layoutChildren = entries.filter((node) => node.nodeFamily === "layout_helper" || node.nodeFamily === "constraint");
        if (layoutChildren.length > 1) {
            issues.push({
                code: "layout_conflict",
                path: layoutChildren[0].parentPath,
                severity: "info",
                message: "Multiple layout primitives share the same parent."
            });
        }
        for (let index = 0; index < entries.length; index += 1) {
            for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
                const left = entries[index];
                const right = entries[otherIndex];
                if ((left.nodeFamily === "renderable" && right.nodeFamily === "renderable")
                    && (looksInteractive(left.className) || looksInteractive(right.className))) {
                    if (rectsOverlap(makeRect(left), makeRect(right))) {
                        issues.push({
                            code: "overlap",
                            path: left.path,
                            severity: "warn",
                            message: `Node overlaps with ${right.path.join("/")}.`,
                            otherPath: right.path
                        });
                    }
                }
            }
        }
    }
    const countsByCode = issues.reduce((acc, issue) => {
        acc[issue.code] = (acc[issue.code] ?? 0) + 1;
        return acc;
    }, {});
    const topIssues = [...issues]
        .sort((a, b) => issueRank(b) - issueRank(a) || a.path.join("/").localeCompare(b.path.join("/")))
        .slice(0, 10);
    return {
        issues,
        summary: {
            countsByCode,
            topIssues,
            suppressedHelperChecks
        }
    };
}
function annotateLayoutFamilies(node) {
    return {
        ...node,
        nodeFamily: classifyLayoutNodeFamily(node.className),
        children: Array.isArray(node.children) ? node.children.map((child) => annotateLayoutFamilies(child)) : []
    };
}
function uiNodeScreenSpace(node) {
    const className = String(node.className ?? "");
    return className === "ScreenGui" || className === "PlayerGui" || className === "PluginGui" || className === "Folder" || node.path?.[0] === "StarterGui";
}
function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
function makeRect(snapshot) {
    const position = snapshot.absolutePosition ?? { x: 0, y: 0 };
    const size = snapshot.absoluteSize ?? { x: 0, y: 0 };
    return {
        left: position.x,
        top: position.y,
        right: position.x + size.x,
        bottom: position.y + size.y
    };
}
function looksInteractive(className) {
    return ["TextButton", "ImageButton", "TextBox", "ScrollingFrame"].includes(String(className ?? ""));
}
function looksTextLike(className) {
    return ["TextLabel", "TextButton", "TextBox"].includes(String(className ?? ""));
}
export class BridgeService {
    sessions = new SessionRegistry();
    queue = new CommandQueue();
    cache;
    index;
    uiIndex;
    startup = new Date().toISOString();
    options;
    lastWriteChannel = null;
    logEntries = [];
    logCursorCounter = 0;
    lastLogAt = null;
    traceStore = new RequestTraceStore();
    constructor(cache, options = {}) {
        this.cache = cache;
        this.index = new RetrievalIndex(cache);
        this.uiIndex = new UiRetrievalIndex(cache);
        this.options = {
            projectAlias: (options.projectAlias ?? "").trim(),
            expectedPlaceId: (options.expectedPlaceId ?? "").trim(),
            bridgeHost: options.bridgeHost ?? "127.0.0.1",
            bridgePort: Number.isFinite(options.bridgePort) ? Math.max(1, Math.trunc(options.bridgePort)) : 5100,
            adminMutationsEnabled: toBool(options.adminMutationsEnabled, false),
            defaultReadMaxAgeMs: Number.isFinite(options.defaultReadMaxAgeMs)
                ? Math.max(0, Math.trunc(options.defaultReadMaxAgeMs))
                : DEFAULT_READ_MAX_AGE_MS
        };
    }
    async bootstrap() {
        await this.cache.bootstrapFromDisk();
        this.lastWriteChannel = this.cache.metadata()?.lastWriteChannel ?? null;
        await this.index.bootstrap();
        await this.uiIndex.bootstrap();
    }
    async hello(payload) {
        if (!payload.clientId || !payload.placeId || !payload.pluginVersion) {
            throw new BridgeError("invalid_hello", "clientId, placeId and pluginVersion are required", 400);
        }
        if (this.options.expectedPlaceId && payload.placeId !== this.options.expectedPlaceId) {
            throw new BridgeError("project_mismatch", `Expected placeId ${this.options.expectedPlaceId}, got ${payload.placeId}`, 409, { expectedPlaceId: this.options.expectedPlaceId, actualPlaceId: payload.placeId });
        }
        const { session } = this.sessions.registerHello(payload);
        this.queue.bindSession(session.sessionId);
        await this.cache.setActivePlace(session.placeId, session.placeName || "UnknownPlace");
        await this.cache.setEditorApiAvailable(session.editorApiAvailable);
        await this.index.switchPlace(this.cache.getActivePlaceId() ?? session.placeId);
        await this.uiIndex.switchPlace(this.cache.getActivePlaceId() ?? session.placeId);
        return session;
    }
    async poll(sessionId, waitMs = 25_000) {
        const session = this.sessions.touchPoll(sessionId);
        if (!session) {
            throw new BridgeError("invalid_session", "Unknown or inactive session", 409);
        }
        const commands = await this.queue.poll(sessionId, Math.max(0, Math.min(waitMs, MAX_STUDIO_POLL_WAIT_MS)), 1);
        return commands;
    }
    async submitResult(sessionId, payload) {
        const session = this.sessions.resolve(sessionId);
        if (!session) {
            throw new BridgeError("invalid_session", "Unknown or inactive session", 409);
        }
        if (!payload.commandId) {
            throw new BridgeError("invalid_result", "commandId is required", 400);
        }
        const command = this.queue.complete(sessionId, payload.commandId, {
            ok: payload.ok,
            result: payload.result,
            error: payload.error
        });
        if (!payload.ok && payload.error && typeof payload.error === "object") {
            payload.error = {
                ...payload.error,
                details: {
                    ...(payload.error.details && typeof payload.error.details === "object" ? payload.error.details : {}),
                    requestId: command.requestId ?? null,
                    commandId: command.commandId
                }
            };
        }
        if (payload.ok &&
            (command.type === "set_script_source_if_hash" || command.type === "upsert_script") &&
            payload.result) {
            const writeChannel = toWriteChannel(payload.result.writeChannel);
            if (writeChannel) {
                this.lastWriteChannel = writeChannel;
                await this.cache.setLastWriteChannel(writeChannel);
            }
        }
    }
    async pushSnapshot(sessionId, payload) {
        const session = this.requireSession(sessionId);
        if (payload.mode !== "all" && payload.mode !== "partial") {
            throw new BridgeError("invalid_mode", "mode must be all or partial", 400);
        }
        if (!Array.isArray(payload.scripts)) {
            throw new BridgeError("invalid_payload", "scripts must be an array", 400);
        }
        const scripts = payload.scripts.map((item) => {
            const path = normalizePath(item.path);
            return {
                path,
                className: toScriptClass(item.class),
                hash: typeof item.hash === "string" ? item.hash : undefined,
                source: decodeSource(item.source, item.sourceBase64),
                draftAware: item.draftAware === true,
                readChannel: toReadChannel(item.readChannel),
                tags: normalizeTagList(item.tags),
                attributes: normalizeAttributesMap(item.attributes)
            };
        });
        if (payload.mode === "all") {
            await this.cache.snapshotAll(session, scripts);
            await this.index.fullRebuildFromCache();
        }
        else {
            await this.cache.upsertMany(session, scripts);
            await this.index.upsertChangedPaths(scripts.map((item) => item.path));
        }
        return scripts.length;
    }
    async pushUiSnapshot(sessionId, payload) {
        const session = this.requireSession(sessionId);
        if (payload.mode !== "all" && payload.mode !== "partial") {
            throw new BridgeError("invalid_mode", "mode must be all or partial", 400);
        }
        if (!Array.isArray(payload.roots)) {
            throw new BridgeError("invalid_payload", "roots must be an array", 400);
        }
        const roots = payload.roots.map((root) => sanitizeUiNodePayload(root));
        if (payload.mode === "all") {
            await this.cache.snapshotUiRoots(session, roots);
            await this.uiIndex.fullRebuildFromCache();
        }
        else {
            await this.cache.upsertUiRoots(session, roots);
            await this.uiIndex.upsertChangedRoots(roots.map((root) => root.path));
        }
        return roots.length;
    }
    async pushLogs(sessionId, payload) {
        this.requireSession(sessionId);
        if (!Array.isArray(payload.entries)) {
            throw new BridgeError("invalid_payload", "entries must be an array", 400);
        }
        for (const entry of payload.entries) {
            const level = typeof entry.level === "string" && LOG_LEVELS.has(entry.level) ? entry.level : "info";
            const normalized = {
                cursor: String(++this.logCursorCounter),
                id: typeof entry.id === "string" && entry.id ? entry.id : `${sessionId}:${this.logCursorCounter}`,
                time: typeof entry.time === "string" && entry.time ? entry.time : nowIso(),
                level,
                message: typeof entry.message === "string" ? entry.message : "",
                source: typeof entry.source === "string" ? entry.source : null,
                playSessionId: typeof entry.playSessionId === "string" ? entry.playSessionId : null,
                requestId: typeof entry.requestId === "string" ? entry.requestId : null,
                commandId: typeof entry.commandId === "string" ? entry.commandId : null
            };
            this.logEntries.push(normalized);
            if (normalized.requestId) {
                this.traceStore.noteLog(normalized.requestId, normalized.id);
            }
            this.lastLogAt = normalized.time;
        }
        if (this.logEntries.length > LOG_BUFFER_LIMIT) {
            this.logEntries.splice(0, this.logEntries.length - LOG_BUFFER_LIMIT);
        }
        return payload.entries.length;
    }
    async ensureCacheWarm() {
        const active = this.liveSession();
        if (!active) {
            throw new BridgeError("studio_offline", "Studio is offline", 503);
        }
        const meta = this.cache.metadata();
        if (!meta) {
            await this.cache.setActivePlace(active.placeId, active.placeName);
        }
        if (!this.cache.isEmpty()) {
            return;
        }
        await this.requestSnapshotAll();
    }
    async ensureUiCacheWarm() {
        const active = this.liveSession();
        if (!active) {
            throw new BridgeError("studio_offline", "Studio is offline", 503);
        }
        const meta = this.cache.metadata();
        if (!meta) {
            await this.cache.setActivePlace(active.placeId, active.placeName);
        }
        if (!this.cache.isUiEmpty()) {
            return;
        }
        await this.requestUiSnapshotAll();
    }
    async listScripts(service, query, limit) {
        await this.ensureCacheWarm();
        return this.cache.listScripts({ service, query, limit });
    }
    async listUiRoots(service, query, limit) {
        await this.ensureUiCacheWarm();
        return this.cache.listUiRoots({ service, query, limit }).map((item) => ({ ...item }));
    }
    async getScript(pathInput) {
        const result = await this.readScript(pathInput);
        return result.script;
    }
    async readScript(pathInput, options = {}) {
        await this.ensureCacheWarm();
        const path = normalizePath(pathInput);
        const maxAgeMs = this.normalizeReadMaxAgeMs(options.maxAgeMs);
        let refreshedBeforeRead = false;
        let script = await this.cache.getScript(path);
        const cacheAgeMs = script ? this.ageMsFromUpdatedAt(script.updatedAt) : Number.POSITIVE_INFINITY;
        if (options.forceRefresh === true || !script || cacheAgeMs > maxAgeMs) {
            script = await this.refreshScript(path);
            refreshedBeforeRead = true;
        }
        if (!script) {
            throw new BridgeError("not_found", `Script not found: ${path.join("/")}`, 404);
        }
        return {
            script,
            fromCache: !refreshedBeforeRead,
            cacheAgeMs: this.ageMsFromUpdatedAt(script.updatedAt),
            refreshedBeforeRead
        };
    }
    async refreshScript(pathInput, trace: unknown = undefined) {
        const path = normalizePath(pathInput);
        await this.requestSnapshotByPath(path, trace);
        const script = await this.cache.getScript(path);
        if (!script) {
            throw new BridgeError("not_found", `Script not found after refresh: ${path.join("/")}`, 404);
        }
        return script;
    }
    async reconcileScriptWriteAfterTimeout(pathInput, expectedSource, options = {}) {
        const path = normalizePath(pathInput);
        const trace = options.trace;
        const stuckPhase = typeof options.stuckPhase === "string" ? options.stuckPhase : "plugin-exec";
        trace?.startPhase("timeout-reconciliation", {
            path: [...path],
            commandId: options.commandId ?? null,
            stuckPhase
        });
        try {
            const verified = await this.refreshScript(path, trace);
            const matchesSource = normalizeSource(verified.source) === normalizeSource(expectedSource);
            const matchesClass = !options.className || verified.className === options.className;
            if (matchesSource && matchesClass) {
                trace?.endPhase("timeout-reconciliation", "ok", {
                    writeState: "applied",
                    hash: verified.hash,
                    className: verified.className
                });
                return {
                    state: "applied",
                    script: {
                        ...verified,
                        reconciledAfterTimeout: true,
                        timedOutDuringPhase: stuckPhase
                    }
                };
            }
            trace?.endPhase("timeout-reconciliation", "error", {
                writeState: "not_applied",
                hash: verified.hash,
                className: verified.className
            });
            return {
                state: "not_applied",
                details: {
                    reconciled: true,
                    writeState: "not_applied",
                    currentHash: verified.hash,
                    currentClassName: verified.className,
                    currentLineCount: sourceLineCount(verified.source),
                    currentPreview: compactSourcePreview(verified.source)
                }
            };
        }
        catch (error) {
            const notFound = error instanceof BridgeError && error.code === "not_found";
            const timeout = error instanceof BridgeError && error.code === "timeout";
            const writeState = notFound && options.allowNotFoundAsNotApplied === true ? "not_applied" : "unknown";
            trace?.endPhase("timeout-reconciliation", "error", {
                writeState: timeout ? "unknown" : writeState,
                code: error instanceof BridgeError ? error.code : "internal"
            });
            return {
                state: timeout ? "unknown" : writeState,
                details: {
                    reconciled: !timeout,
                    writeState: timeout ? "unknown" : writeState,
                    reconciliationErrorCode: error instanceof BridgeError ? error.code : "internal",
                    reconciliationErrorMessage: error instanceof Error ? error.message : String(error)
                }
            };
        }
    }
    async readUiTree(pathInput, depth, options = {}) {
        await this.ensureUiCacheWarm();
        const path = normalizePath(pathInput);
        const maxAgeMs = this.normalizeReadMaxAgeMs(options.maxAgeMs);
        let refreshedBeforeRead = false;
        let tree = await this.cache.getUiTree(path, depth);
        const cacheAgeMs = tree ? this.ageMsFromUpdatedAt(tree.updatedAt) : Number.POSITIVE_INFINITY;
        if (options.forceRefresh === true || !tree || cacheAgeMs > maxAgeMs) {
            tree = await this.refreshUiTree(path, depth);
            refreshedBeforeRead = true;
        }
        if (!tree) {
            throw new BridgeError("not_found", `UI path not found: ${path.join("/")}`, 404);
        }
        return {
            tree,
            fromCache: !refreshedBeforeRead,
            cacheAgeMs: this.ageMsFromUpdatedAt(tree.updatedAt),
            refreshedBeforeRead
        };
    }
    async getUiTree(pathInput, depth, options = {}) {
        return (await this.readUiTree(pathInput, depth, options)).tree;
    }
    async refreshUiTree(pathInput, depth) {
        const path = normalizePath(pathInput);
        await this.requestUiSnapshotByPath(path);
        const tree = await this.cache.getUiTree(path, depth);
        if (!tree) {
            throw new BridgeError("not_found", `UI path not found after refresh: ${path.join("/")}`, 404);
        }
        return tree;
    }
    async updateScript(pathInput, newSource, expectedHash, placeId, trace: unknown = undefined) {
        this.assertMutatingPlace(placeId);
        const path = normalizePath(pathInput);
        if (!expectedHash || typeof expectedHash !== "string") {
            throw new BridgeError("invalid_expected_hash", "expectedHash is required", 400);
        }
        const active = this.liveSession();
        if (!active) {
            throw new BridgeError("studio_offline", "No active Studio session", 503);
        }
        const cachedBefore = await this.cache.getScript(path);
        trace?.startPhase("pre-refresh", { path: [...path], skipped: true, reason: "plugin_hash_check" });
        trace?.endPhase("pre-refresh", "ok", { skipped: true, reason: "plugin_hash_check" });
        const useBase64 = active?.base64Transport === true;
        trace?.startPhase("queue-write", { path: [...path] });
        const queued = this.queue.enqueueDetailed("set_script_source_if_hash", {
            path,
            expectedHash,
            newSource,
            newSourceBase64: useBase64 ? Buffer.from(newSource, "utf8").toString("base64") : undefined,
            requestId: trace?.requestId
        }, COMMAND_TIMEOUTS_MS.set_script_source_if_hash);
        trace?.noteCommand(queued.command.commandId, queued.command.type);
        trace?.endPhase("queue-write", "ok", { commandId: queued.command.commandId });
        trace?.startPhase("plugin-exec", { commandId: queued.command.commandId });
        let result;
        try {
            result = await queued.result;
            trace?.endPhase("plugin-exec", "ok", { commandId: queued.command.commandId });
        }
        catch (error) {
            trace?.endPhase("plugin-exec", "error", {
                commandId: queued.command.commandId,
                code: error instanceof BridgeError ? error.code : "internal"
            });
            if (error instanceof BridgeError && error.code === "timeout") {
                const reconciled = await this.reconcileScriptWriteAfterTimeout(path, newSource, {
                    trace,
                    commandId: queued.command.commandId,
                    stuckPhase: "plugin-exec",
                    className: cachedBefore?.className ?? null
                });
                if (reconciled.state === "applied") {
                    await this.cache.recordChangedItems("script", "script_write", [{ path: reconciled.script.path, updatedAt: reconciled.script.updatedAt }]);
                    return reconciled.script;
                }
                throw new BridgeError("timeout", error.message, error.status, {
                    ...(error.details && typeof error.details === "object" ? error.details : {}),
                    requestId: trace?.requestId ?? null,
                    lastCompletedPhase: "queue-write",
                    stuckPhase: "plugin-exec",
                    commandId: queued.command.commandId,
                    ...buildWriteExpectationDetails(newSource, cachedBefore?.className ?? null),
                    ...(reconciled.details ?? {})
                });
            }
            throw error;
        }
        const updatedPath = Array.isArray(result?.path) ? normalizePath(result.path) : path;
        const updated = {
            path: updatedPath,
            className: toScriptClass(result?.className ?? cachedBefore?.className ?? "LocalScript"),
            source: newSource,
            hash: typeof result?.hash === "string" && result.hash.length > 0 ? result.hash : undefined,
            draftAware: result?.draftAware === true,
            readChannel: toReadChannel(result?.readChannel ?? result?.writeChannel ?? cachedBefore?.readChannel),
            tags: normalizeTagList(result?.tags ?? cachedBefore?.tags),
            attributes: normalizeAttributesMap(result?.attributes ?? cachedBefore?.attributes)
        };
        if (shouldVerifyScriptWrite(newSource)) {
            trace?.startPhase("post-refresh", { path: [...updated.path], verification: "multiline_integrity_check" });
            let verified;
            try {
                verified = await this.refreshScript(updated.path, trace);
                if (normalizeSource(verified.source) !== normalizeSource(newSource)) {
                    throw buildWriteVerificationError(updated.path, newSource, verified.source);
                }
                trace?.endPhase("post-refresh", "ok", {
                    verification: "multiline_integrity_check",
                    hash: verified.hash
                });
            }
            catch (error) {
                trace?.endPhase("post-refresh", "error");
                if (error instanceof BridgeError && error.code === "timeout") {
                    const reconciled = await this.reconcileScriptWriteAfterTimeout(updated.path, newSource, {
                        trace,
                        commandId: queued.command.commandId,
                        stuckPhase: "post-refresh",
                        className: updated.className ?? cachedBefore?.className ?? null
                    });
                    if (reconciled.state === "applied") {
                        await this.cache.recordChangedItems("script", "script_write", [{ path: reconciled.script.path, updatedAt: reconciled.script.updatedAt }]);
                        return reconciled.script;
                    }
                    throw new BridgeError("timeout", error.message, error.status, {
                        ...(error.details && typeof error.details === "object" ? error.details : {}),
                        requestId: trace?.requestId ?? null,
                        lastCompletedPhase: "plugin-exec",
                        stuckPhase: "post-refresh",
                        commandId: queued.command.commandId,
                        ...buildWriteExpectationDetails(newSource, updated.className ?? cachedBefore?.className ?? null),
                        ...(reconciled.details ?? {})
                    });
                }
                throw error;
            }
            await this.cache.recordChangedItems("script", "script_write", [{ path: verified.path, updatedAt: verified.updatedAt }]);
            return verified;
        }
        trace?.startPhase("post-refresh", { path: [...updated.path], skipped: true, reason: "cache_updated_from_write_result" });
        await this.cache.upsertMany(active, [updated]);
        await this.index.upsertChangedPaths([updated.path]);
        const stored = await this.cache.getScript(updated.path);
        trace?.endPhase("post-refresh", "ok", {
            skipped: true,
            reason: "cache_updated_from_write_result",
            hash: updated.hash ?? null
        });
        if (!stored) {
            throw new BridgeError("internal", `Script cache write failed after update: ${updated.path.join("/")}`, 500, { path: updated.path });
        }
        await this.cache.recordChangedItems("script", "script_write", [{ path: stored.path, updatedAt: stored.updatedAt }]);
        return stored;
    }
    async createScript(pathInput, classNameInput, source, placeId, trace: unknown = undefined) {
        this.assertMutatingPlace(placeId);
        const path = normalizePath(pathInput);
        const className = toScriptClass(classNameInput);
        trace?.startPhase("pre-refresh", { path: [...path], mode: "create_if_missing" });
        try {
            await this.refreshScript(path, trace);
            trace?.endPhase("pre-refresh", "ok", { exists: true });
        }
        catch (error) {
            if (error instanceof BridgeError && error.code === "not_found") {
                trace?.endPhase("pre-refresh", "ok", { exists: false });
                return this.upsertScript(path, className, source, { placeId, trace });
            }
            trace?.endPhase("pre-refresh", "error");
            throw error;
        }
        throw new BridgeError("already_exists", `Script already exists: ${path.join("/")}`, 409, { path });
    }
    async deleteScript(pathInput, expectedHash, placeId) {
        this.assertMutatingPlace(placeId);
        const path = normalizePath(pathInput);
        if (!expectedHash || typeof expectedHash !== "string") {
            throw new BridgeError("invalid_expected_hash", "expectedHash is required", 400);
        }
        const current = await this.refreshScript(path);
        if (current.hash !== expectedHash) {
            throw new BridgeError("hash_conflict", "Hash mismatch before delete", 409, {
                expectedHash,
                currentHash: current.hash
            });
        }
        await this.queue.enqueue("delete_script_if_hash", {
            path,
            expectedHash: current.hash
        }, COMMAND_TIMEOUTS_MS.delete_script_if_hash);
        try {
            await this.requestSnapshotByPath(path);
            throw new BridgeError("delete_verification_failed", `Script still exists after delete: ${path.join("/")}`, 409, { path });
        }
        catch (error) {
            if (!(error instanceof BridgeError) || error.code !== "not_found") {
                throw error;
            }
        }
        await this.cache.deleteScript(path);
        return {
            deletedPath: path,
            deletedHash: current.hash,
            recommendedNextCalls: ["rbx_list_scripts", "rbx_search_text"]
        };
    }
    async moveScript(pathInput, newParentPathInput, expectedHash, newName, placeId) {
        this.assertMutatingPlace(placeId);
        const path = normalizePath(pathInput);
        const newParentPath = normalizeParentPathInput(newParentPathInput);
        if (!expectedHash || typeof expectedHash !== "string") {
            throw new BridgeError("invalid_expected_hash", "expectedHash is required", 400);
        }
        const current = await this.refreshScript(path);
        if (current.hash !== expectedHash) {
            throw new BridgeError("hash_conflict", "Hash mismatch before move", 409, {
                expectedHash,
                currentHash: current.hash
            });
        }
        const finalName = typeof newName === "string" && newName.trim() ? newName.trim() : current.name;
        const nextPath = [...newParentPath, finalName];
        await this.queue.enqueue("move_script_if_hash", {
            path,
            expectedHash: current.hash,
            newParentPath,
            newName: finalName
        }, COMMAND_TIMEOUTS_MS.move_script_if_hash);
        await this.requestSnapshotByPath(nextPath);
        const moved = await this.cache.getScript(nextPath);
        if (!moved) {
            throw new BridgeError("not_found", `Moved script not found after refresh: ${nextPath.join("/")}`, 404, { path: nextPath });
        }
        await this.cache.moveScript(path, {
            path: moved.path,
            className: moved.className,
            source: moved.source,
            hash: moved.hash,
            draftAware: moved.draftAware,
            readChannel: moved.readChannel,
            tags: moved.tags,
            attributes: moved.attributes
        });
        return moved;
    }
    async updateScriptMetadata(pathInput, expectedHash, metadataInput, placeId, trace: unknown = undefined) {
        this.assertMutatingPlace(placeId);
        const path = normalizePath(pathInput);
        if (!expectedHash || typeof expectedHash !== "string") {
            throw new BridgeError("invalid_expected_hash", "expectedHash is required", 400);
        }
        const current = await this.refreshScript(path, trace);
        if (current.hash !== expectedHash) {
            throw new BridgeError("hash_conflict", "Hash mismatch before metadata write", 409, {
                expectedHash,
                currentHash: current.hash
            });
        }
        const active = this.liveSession();
        if (!active) {
            throw new BridgeError("studio_offline", "No active Studio session", 503);
        }
        const metadata = metadataInput && typeof metadataInput === "object" ? metadataInput : {};
        const tagPatch = normalizeMetadataTagPatch(current.tags, metadata);
        const expectedTags = tagPatch.expectedTags;
        const expectedAttributes = applyMetadataPatchToAttributes(current.attributes, metadata);
        const queued = this.queue.enqueueDetailed("set_script_metadata_if_hash", {
            path,
            expectedHash: current.hash,
            addTags: tagPatch.addTags,
            removeTags: tagPatch.removeTags,
            attributes: normalizeAttributesMap(metadata.attributes),
            clearAttributes: Array.isArray(metadata.clearAttributes) ? metadata.clearAttributes.map((entry) => String(entry)) : [],
            requestId: trace?.requestId
        }, COMMAND_TIMEOUTS_MS.set_script_source_if_hash);
        trace?.noteCommand(queued.command.commandId, queued.command.type);
        await queued.result;
        const refreshed = await this.refreshScript(path, trace);
        const actualTags = normalizeTagList(refreshed.tags);
        const actualAttributes = normalizeAttributesMap(refreshed.attributes);
        if (stableJson(actualTags) !== stableJson(expectedTags) || !sameMetadataAttributes(actualAttributes, expectedAttributes)) {
            throw buildMetadataVerificationError("script", refreshed.path, expectedTags, actualTags, expectedAttributes, actualAttributes);
        }
        await this.cache.recordChangedItems("script", "script_write", [{ path: refreshed.path, updatedAt: refreshed.updatedAt }]);
        return refreshed;
    }
    async upsertScript(pathInput, classNameInput, source, options = {}) {
        this.assertMutatingPlace(options.placeId);
        const path = normalizePath(pathInput);
        const className = toScriptClass(classNameInput);
        const active = this.liveSession();
        if (!active) {
            throw new BridgeError("studio_offline", "No active Studio session", 503);
        }
        const useBase64 = active?.base64Transport === true;
        const trace = options.trace;
        trace?.startPhase("queue-write", { path: [...path], className });
        const queued = this.queue.enqueueDetailed("upsert_script", {
            path,
            className,
            newSource: source,
            newSourceBase64: useBase64 ? Buffer.from(source, "utf8").toString("base64") : undefined,
            requestId: trace?.requestId
        }, COMMAND_TIMEOUTS_MS.upsert_script);
        trace?.noteCommand(queued.command.commandId, queued.command.type);
        trace?.endPhase("queue-write", "ok", { commandId: queued.command.commandId });
        trace?.startPhase("plugin-exec", { commandId: queued.command.commandId });
        let result;
        try {
            result = await queued.result;
            trace?.endPhase("plugin-exec", "ok", { commandId: queued.command.commandId });
        }
        catch (error) {
            trace?.endPhase("plugin-exec", "error", {
                commandId: queued.command.commandId,
                code: error instanceof BridgeError ? error.code : "internal"
            });
            if (error instanceof BridgeError && error.code === "timeout") {
                const reconciled = await this.reconcileScriptWriteAfterTimeout(path, source, {
                    trace,
                    commandId: queued.command.commandId,
                    stuckPhase: "plugin-exec",
                    className,
                    allowNotFoundAsNotApplied: true
                });
                if (reconciled.state === "applied") {
                    await this.cache.recordChangedItems("script", "script_write", [{ path: reconciled.script.path, updatedAt: reconciled.script.updatedAt }]);
                    return reconciled.script;
                }
                throw new BridgeError("timeout", error.message, error.status, {
                    ...(error.details && typeof error.details === "object" ? error.details : {}),
                    requestId: trace?.requestId ?? null,
                    lastCompletedPhase: "queue-write",
                    stuckPhase: "plugin-exec",
                    commandId: queued.command.commandId,
                    ...buildWriteExpectationDetails(source, className),
                    ...(reconciled.details ?? {})
                });
            }
            throw error;
        }
        const createdPath = Array.isArray(result?.path) ? normalizePath(result.path) : path;
        const created = {
            path: createdPath,
            className: toScriptClass(result?.className ?? className),
            source,
            hash: typeof result?.hash === "string" && result.hash.length > 0 ? result.hash : undefined,
            draftAware: result?.draftAware === true,
            readChannel: toReadChannel(result?.readChannel),
            tags: normalizeTagList(result?.tags),
            attributes: normalizeAttributesMap(result?.attributes)
        };
        if (shouldVerifyScriptWrite(source)) {
            trace?.startPhase("post-refresh", { path: [...created.path], verification: "multiline_integrity_check" });
            let verified;
            try {
                verified = await this.refreshScript(created.path, trace);
                if (normalizeSource(verified.source) !== normalizeSource(source)) {
                    throw buildWriteVerificationError(created.path, source, verified.source);
                }
                trace?.endPhase("post-refresh", "ok", {
                    verification: "multiline_integrity_check",
                    hash: verified.hash
                });
            }
            catch (error) {
                trace?.endPhase("post-refresh", "error");
                if (error instanceof BridgeError && error.code === "timeout") {
                    const reconciled = await this.reconcileScriptWriteAfterTimeout(created.path, source, {
                        trace,
                        commandId: queued.command.commandId,
                        stuckPhase: "post-refresh",
                        className,
                        allowNotFoundAsNotApplied: true
                    });
                    if (reconciled.state === "applied") {
                        await this.cache.recordChangedItems("script", "script_write", [{ path: reconciled.script.path, updatedAt: reconciled.script.updatedAt }]);
                        return reconciled.script;
                    }
                    throw new BridgeError("timeout", error.message, error.status, {
                        ...(error.details && typeof error.details === "object" ? error.details : {}),
                        requestId: trace?.requestId ?? null,
                        lastCompletedPhase: "plugin-exec",
                        stuckPhase: "post-refresh",
                        commandId: queued.command.commandId,
                        ...buildWriteExpectationDetails(source, className),
                        ...(reconciled.details ?? {})
                    });
                }
                throw error;
            }
            await this.cache.recordChangedItems("script", "script_write", [{ path: verified.path, updatedAt: verified.updatedAt }]);
            return verified;
        }
        await this.cache.upsertMany(active, [created]);
        await this.index.upsertChangedPaths([created.path]);
        const stored = await this.cache.getScript(created.path);
        if (!stored) {
            throw new BridgeError("internal", `Script cache write failed after upsert: ${created.path.join("/")}`, 500, { path: created.path });
        }
        await this.cache.recordChangedItems("script", "script_write", [{ path: created.path, updatedAt: created.updatedAt }]);
        return stored;
    }
    async validateOperation(kindInput, payloadInput) {
        const kind = String(kindInput ?? "").trim();
        const payload = payloadInput && typeof payloadInput === "object" ? payloadInput : {};
        const issues = [];
        if (kind === "script_delete") {
            await this.ensureCacheWarm();
            try {
                const path = normalizePath(payload.path);
                const script = await this.cache.getScript(path);
                if (!script) {
                    issues.push({ code: "not_found", message: `Script not found: ${path.join("/")}` });
                }
            }
            catch {
                issues.push({ code: "not_found", message: "path must be a valid script path" });
            }
            if (typeof payload.expectedHash !== "string" || !payload.expectedHash.trim()) {
                issues.push({ code: "invalid_expected_hash", message: "expectedHash is required" });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_delete_script"] : ["rbx_get_script", "rbx_explain_error"]
            };
        }
        if (kind === "script_move") {
            await this.ensureCacheWarm();
            try {
                const path = normalizePath(payload.path);
                const newParentPath = normalizeParentPathInput(payload.newParentPath);
                const script = await this.cache.getScript(path);
                if (!script) {
                    issues.push({ code: "not_found", message: `Script not found: ${path.join("/")}` });
                }
                if (newParentPath.length < 1) {
                    issues.push({ code: "script_parent_not_found", message: "newParentPath must point to an existing parent" });
                }
            }
            catch {
                issues.push({ code: "invalid_request", message: "path and newParentPath must be valid paths" });
            }
            if (typeof payload.expectedHash !== "string" || !payload.expectedHash.trim()) {
                issues.push({ code: "invalid_expected_hash", message: "expectedHash is required" });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_move_script"] : ["rbx_get_script", "rbx_explain_error"]
            };
        }
        if (kind === "script_patch") {
            await this.ensureCacheWarm();
            try {
                const path = normalizePath(payload.path);
                const script = await this.cache.getScript(path);
                if (!script) {
                    issues.push({ code: "not_found", message: `Script not found: ${path.join("/")}` });
                }
            }
            catch {
                issues.push({ code: "patch_invalid", message: "path must be a valid script path" });
            }
            if (payload.expectedHash !== undefined && typeof payload.expectedHash !== "string") {
                issues.push({ code: "patch_invalid", message: "expectedHash must be a string when provided" });
            }
            issues.push(...validateScriptPatchOps(payload.patch ?? []));
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_apply_script_patch", "rbx_diff_script"] : ["rbx_get_script", "rbx_explain_error"]
            };
        }
        if (kind === "ui_clone") {
            await this.ensureUiCacheWarm();
            try {
                const rootPath = normalizePath(payload.rootPath);
                const sourcePath = normalizePath(payload.sourcePath);
                const newParentPath = normalizePath(payload.newParentPath);
                const root = await this.cache.getUiTree(rootPath);
                if (!root) {
                    issues.push({ code: "not_found", message: `UI root not found: ${rootPath.join("/")}` });
                }
                else {
                    if (!pathStartsWithPrefix(sourcePath, rootPath)) {
                        issues.push({ code: "ui_operation_out_of_root", message: "sourcePath must stay inside rootPath" });
                    }
                    if (!pathStartsWithPrefix(newParentPath, rootPath)) {
                        issues.push({ code: "ui_operation_out_of_root", message: "newParentPath must stay inside rootPath" });
                    }
                    const sourceNode = findUiNodeByPath(root, sourcePath);
                    if (!sourceNode) {
                        issues.push({ code: "not_found", message: `UI source not found: ${sourcePath.join("/")}` });
                    }
                    const parentNode = findUiNodeByPath(root, newParentPath);
                    if (!parentNode) {
                        issues.push({ code: "not_found", message: `UI parent not found: ${newParentPath.join("/")}` });
                    }
                    const finalName = typeof payload.newName === "string" && payload.newName.trim() ? payload.newName.trim() : sourceNode?.name;
                    if (parentNode?.children.some((child) => child.name === finalName)) {
                        issues.push({ code: "already_exists", message: `UI node already exists: ${[...newParentPath, finalName].join("/")}` });
                    }
                }
            }
            catch {
                issues.push({ code: "invalid_ui_operation", message: "rootPath/sourcePath/newParentPath must be valid UI paths" });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_clone_ui_subtree"] : ["rbx_get_ui_tree", "rbx_explain_error"]
            };
        }
        if (kind === "ui_template") {
            await this.ensureUiCacheWarm();
            const supportedKinds = new Set(["modal", "shop_grid"]);
            if (!supportedKinds.has(String(payload.kind ?? ""))) {
                issues.push({ code: "template_invalid", message: "kind must be modal or shop_grid" });
            }
            try {
                const rootPath = normalizePath(payload.rootPath);
                const targetPath = normalizePath(payload.targetPath);
                const root = await this.cache.getUiTree(rootPath);
                if (!root) {
                    issues.push({ code: "not_found", message: `UI root not found: ${rootPath.join("/")}` });
                }
                else if (!pathStartsWithPrefix(targetPath, rootPath)) {
                    issues.push({ code: "ui_operation_out_of_root", message: "targetPath must stay inside rootPath" });
                }
                else if (!findUiNodeByPath(root, targetPath)) {
                    issues.push({ code: "not_found", message: `UI target not found: ${targetPath.join("/")}` });
                }
            }
            catch {
                issues.push({ code: "template_invalid", message: "rootPath/targetPath must be valid UI paths" });
            }
            if (!payload.options || typeof payload.options !== "object") {
                issues.push({ code: "template_invalid", message: "options must be an object" });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_apply_ui_template"] : ["rbx_get_ui_tree", "rbx_explain_error"]
            };
        }
        if (kind === "ui_batch") {
            try {
                const rootPath = normalizePath(payload.rootPath);
                const operations = Array.isArray(payload.operations) ? payload.operations.map((operation) => normalizeUiBatchOperation(operation)) : [];
                const resolved = resolveUiOperationRefs(rootPath, operations);
                for (const operation of resolved.operations) {
                    ensureUiOperationWithinRoot(rootPath, operation);
                }
            }
            catch (error) {
                issues.push({ code: error instanceof BridgeError ? error.code : "invalid_ui_operation", message: error instanceof Error ? error.message : String(error) });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_apply_ui_batch"] : ["rbx_explain_error"]
            };
        }
        if (kind === "ui_layout") {
            await this.ensureUiCacheWarm();
            try {
                const path = normalizePath(payload.path);
                const tree = await this.cache.getUiTree(path);
                if (!tree) {
                    issues.push({ code: "not_found", message: `UI path not found: ${path.join("/")}` });
                }
            }
            catch {
                issues.push({ code: "invalid_request", message: "path must be a valid UI path" });
            }
            return {
                valid: issues.length === 0,
                normalizedKind: kind,
                issues,
                recommendedNextCalls: issues.length === 0 ? ["rbx_get_ui_layout_snapshot", "rbx_validate_ui_layout"] : ["rbx_explain_error"]
            };
        }
        throw new BridgeError("invalid_operation_kind", "kind must be script_delete | script_move | script_patch | ui_clone | ui_template | ui_batch | ui_layout", 400);
    }
    async applyScriptPatch(pathInput, expectedHash, patchInput, placeId, options = {}) {
        this.assertMutatingPlace(placeId);
        const trace = options.trace;
        trace?.startPhase("validate", { patchLength: Array.isArray(patchInput) ? patchInput.length : 0 });
        const validationIssues = validateScriptPatchOps(patchInput);
        if (validationIssues.length > 0) {
            trace?.endPhase("validate", "error", { issues: validationIssues.length });
            throw new BridgeError("patch_invalid", validationIssues[0].message, 400, { issues: validationIssues });
        }
        trace?.endPhase("validate", "ok");
        trace?.startPhase("pre-refresh");
        const current = await this.readScript(pathInput, { forceRefresh: true, maxAgeMs: 0 });
        trace?.endPhase("pre-refresh", "ok", { hash: current.script.hash });
        if (current.script.hash !== expectedHash) {
            throw new BridgeError("hash_conflict", "Hash mismatch before patch write", 409, {
                expectedHash,
                currentHash: current.script.hash
            });
        }
        let patched;
        try {
            patched = applyScriptPatch(current.script.source, patchInput);
        }
        catch (error) {
            const code = error?.name === "patch_target_not_found" ? "patch_target_not_found" : "patch_invalid";
            throw new BridgeError(code, error instanceof Error ? error.message : String(error), 400, {
                operationIndex: error?.operationIndex ?? null,
                matchedCount: error?.matchedCount ?? null,
                ambiguousMatches: error?.ambiguousMatches ?? null,
                nearbyContext: error?.nearbyContext ?? null
            });
        }
        if (options.dryRun === true) {
            trace?.startPhase("dry-run");
            trace?.endPhase("dry-run", "ok");
            return {
                path: current.script.path,
                hash: current.script.hash,
                updatedAt: current.script.updatedAt,
                operationsApplied: patched.operationsApplied,
                previewSource: patched.source,
                diff: diffLines(current.script.source, patched.source),
                dryRun: true,
                applicable: true,
                recommendedNextCalls: ["rbx_apply_script_patch", "rbx_diff_script"]
            };
        }
        const updated = await this.updateScript(current.script.path, patched.source, current.script.hash, placeId, trace);
        return {
            path: updated.path,
            hash: updated.hash,
            updatedAt: updated.updatedAt,
            operationsApplied: patched.operationsApplied,
            source: updated.source,
            dryRun: false,
            recommendedNextCalls: ["rbx_diff_script", "rbx_get_script"]
        };
    }
    async diffScript(pathInput, baseHash, options = {}) {
        const current = await this.readScript(pathInput, options);
        const base = baseHash
            ? await this.cache.getScriptVersion(current.script.path, baseHash)
            : await this.cache.getPreviousScriptVersion(current.script.path);
        if (!base) {
            throw new BridgeError("base_not_available", "Base script version is not available for diff", 404, {
                path: current.script.path,
                requestedBaseHash: baseHash ?? null
            });
        }
        const diff = diffLines(base.source, current.script.source);
        return {
            path: current.script.path,
            currentHash: current.script.hash,
            baseHash: base.hash,
            summary: diff.summary,
            hunks: diff.hunks,
            recommendedNextCalls: ["rbx_get_script", "rbx_apply_script_patch"]
        };
    }
    async cloneUiSubtree(rootPathInput, sourcePathInput, newParentPathInput, expectedVersion, newName, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const rootPath = normalizePath(rootPathInput);
        const sourcePath = normalizePath(sourcePathInput);
        const newParentPath = normalizePath(newParentPathInput);
        const root = await this.refreshUiTree(rootPath);
        if (root.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before clone", 409, {
                expectedVersion,
                currentVersion: root.version
            });
        }
        if (!pathStartsWithPrefix(sourcePath, rootPath) || !pathStartsWithPrefix(newParentPath, rootPath)) {
            throw new BridgeError("ui_operation_out_of_root", "clone paths must stay inside rootPath", 400, {
                rootPath,
                sourcePath,
                newParentPath
            });
        }
        const sourceNode = findUiNodeByPath(root, sourcePath);
        const parentNode = findUiNodeByPath(root, newParentPath);
        if (!sourceNode) {
            throw new BridgeError("not_found", `UI source not found: ${sourcePath.join("/")}`, 404);
        }
        if (!parentNode) {
            throw new BridgeError("not_found", `UI parent not found: ${newParentPath.join("/")}`, 404);
        }
        const finalName = typeof newName === "string" && newName.trim() ? newName.trim() : sourceNode.name;
        if (parentNode.children.some((child) => child.name === finalName)) {
            throw new BridgeError("already_exists", `UI node already exists: ${[...newParentPath, finalName].join("/")}`, 409, {
                path: [...newParentPath, finalName]
            });
        }
        const operations = cloneUiOpsFromSubtree(sourceNode, newParentPath, finalName);
        const result = await this.applyUiBatch(rootPath, expectedVersion, operations, placeId);
        const cloned = await this.cache.getUiTree([...newParentPath, finalName]);
        return {
            ...result,
            clonedPath: [...newParentPath, finalName],
            clonedNode: cloned
        };
    }
    async applyUiTemplate(kindInput, rootPathInput, targetPathInput, expectedVersion, optionsInput, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const kind = String(kindInput ?? "").trim();
        const rootPath = normalizePath(rootPathInput);
        const targetPath = normalizePath(targetPathInput);
        const options = this.normalizeTemplateOptions(kind, optionsInput);
        const root = await this.refreshUiTree(rootPath);
        if (root.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before template apply", 409, {
                expectedVersion,
                currentVersion: root.version
            });
        }
        if (!pathStartsWithPrefix(targetPath, rootPath)) {
            throw new BridgeError("ui_operation_out_of_root", "targetPath must stay inside rootPath", 400, { rootPath, targetPath });
        }
        if (!findUiNodeByPath(root, targetPath)) {
            throw new BridgeError("not_found", `UI target not found: ${targetPath.join("/")}`, 404);
        }
        const operations = kind === "modal" ? compileModalTemplate(targetPath, options) : compileShopGridTemplate(targetPath, options);
        const result = await this.applyUiBatch(rootPath, expectedVersion, operations, placeId);
        return {
            ...result,
            kind,
            recommendedNextCalls: ["rbx_get_ui_tree", "rbx_search_ui"]
        };
    }
    async searchText(query, options = {}) {
        await this.ensureIndexWarm();
        return this.index.searchText(query, options);
    }
    async findEntrypoints(query, service, limit, verbosity = "normal") {
        await this.ensureIndexWarm();
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const items = this.index.findEntrypoints({ query, service, limit });
        return effectiveVerbosity === "minimal" ? this.trimReasons(items, 1) : items;
    }
    async findRemotes(query, limit, verbosity = "normal") {
        await this.ensureIndexWarm();
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const items = this.index.findRemotes({ query, limit });
        if (effectiveVerbosity !== "minimal") {
            return items;
        }
        return items.map((item) => ({
            ...item,
            snippets: item.snippets.slice(0, 1),
            evidence: this.trimStrings(item.evidence, 2),
            argHints: this.trimStrings(item.argHints, 1),
            pairedParticipants: item.pairedParticipants.slice(0, 2)
        }));
    }
    async rankFilesByRelevance(query, limit, verbosity = "normal") {
        await this.ensureIndexWarm();
        await this.ensureUiIndexWarm();
        const uiHits = this.cache.uiRootCount() > 0 ? await this.searchUi(query, { limit: 20 }) : [];
        const remoteHits = this.index.findRemotes({ query, limit: 50 });
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const items = this.index.rankFilesByRelevance(query, { limit, uiHits, remoteHits });
        return effectiveVerbosity === "minimal"
            ? items.map((item) => ({
                path: item.path,
                className: item.className,
                score: item.score,
                why: this.trimStrings(item.why, 1)
            }))
            : items;
    }
    getChangedSince(cursorOrTimestamp, limit) {
        return this.cache.getChangedSince(cursorOrTimestamp, limit);
    }
    async getSymbolContext(symbol, budgetTokens, verbosity = "normal") {
        await this.ensureIndexWarm();
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const result = this.index.getSymbolContext(symbol, budgetTokens);
        return {
            ...result,
            references: effectiveVerbosity === "minimal" ? result.references.slice(0, 5) : result.references,
            relatedScripts: effectiveVerbosity === "minimal" ? result.relatedScripts.slice(0, 6) : result.relatedScripts,
            chunks: this.compactChunks(result.chunks, effectiveVerbosity)
        };
    }
    async searchUi(query, options = {}) {
        await this.ensureUiIndexWarm();
        return this.uiIndex.search(query, options);
    }
    async findSymbols(options) {
        await this.ensureIndexWarm();
        return this.index.findSymbols(options);
    }
    async findReferences(symbol, options = {}) {
        await this.ensureIndexWarm();
        return this.index.findReferences(symbol, options);
    }
    async getContextBundle(options) {
        await this.ensureIndexWarm();
        const effectiveVerbosity = this.normalizeVerbosity(options?.verbosity);
        const bundle = this.index.getContextBundle(options);
        return {
            ...bundle,
            chunks: this.compactChunks(bundle.chunks, effectiveVerbosity)
        };
    }
    async getProjectSummary(scope = "all", service, verbosity = "normal") {
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const normalizedScope = scope === "scripts" || scope === "ui" ? scope : "all";
        if (normalizedScope === "all" || normalizedScope === "scripts") {
            await this.ensureIndexWarm();
        }
        if (normalizedScope === "all" || normalizedScope === "ui") {
            await this.ensureUiIndexWarm();
        }
        const cacheMeta = this.cache.metadata();
        const project = this.health().cache ?? {};
        const scriptSummary = normalizedScope === "ui" ? null : this.index.getProjectSummary({ service });
        const uiRoots = normalizedScope === "scripts" ? [] : this.cache.listUiRoots({ service, limit: 500 });
        const uiSummaries = normalizedScope === "scripts"
            ? []
            : uiRoots.map((root) => this.uiIndex.summarizeTree(root.path)).filter((item) => Boolean(item));
        const uiServiceCounts = new Map();
        let interactiveCount = 0;
        let textNodeCount = 0;
        for (const root of uiRoots) {
            uiServiceCounts.set(root.service, (uiServiceCounts.get(root.service) ?? 0) + 1);
        }
        for (const summary of uiSummaries) {
            interactiveCount += summary.interactiveNodes.length;
            textNodeCount += summary.textNodes.length;
        }
        const highlights = [];
        if (scriptSummary?.likelyEntrypoints?.[0]) {
            highlights.push(`Likely entrypoint: ${scriptSummary.likelyEntrypoints[0].path.join("/")}`);
        }
        if (scriptSummary?.hotSpots?.[0]) {
            highlights.push(`Hot spot: ${scriptSummary.hotSpots[0].path.join("/")}`);
        }
        if (uiRoots[0]) {
            highlights.push(`Top UI root: ${uiRoots[0].path.join("/")}`);
        }
        const response = {
            placeId: project.placeId ?? cacheMeta?.placeId ?? null,
            placeName: project.placeName ?? cacheMeta?.placeName ?? null,
            scope: normalizedScope,
            scripts: scriptSummary
                ? {
                    totalScripts: scriptSummary.totalScripts,
                    moduleCount: scriptSummary.moduleCount,
                    classCounts: effectiveVerbosity === "minimal" ? scriptSummary.classCounts.slice(0, 3) : scriptSummary.classCounts,
                    services: effectiveVerbosity === "minimal" ? scriptSummary.services.slice(0, 3) : scriptSummary.services,
                    likelyEntrypoints: effectiveVerbosity === "minimal" ? scriptSummary.likelyEntrypoints.slice(0, 3) : scriptSummary.likelyEntrypoints,
                    hotSpots: effectiveVerbosity === "minimal" ? scriptSummary.hotSpots.slice(0, 3) : scriptSummary.hotSpots
                }
                : null,
            ui: normalizedScope === "scripts"
                ? null
                : {
                    rootCount: uiRoots.length,
                    topRoots: uiRoots.slice(0, effectiveVerbosity === "minimal" ? 3 : 5).map((root) => ({
                        path: root.path,
                        className: root.className,
                        version: root.version
                    })),
                    serviceCounts: [...uiServiceCounts.entries()]
                        .map(([label, count]) => ({ label, count }))
                        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
                        .slice(0, effectiveVerbosity === "minimal" ? 4 : 12),
                    interactiveCount,
                    textNodeCount
                },
            highlights: effectiveVerbosity === "minimal" ? highlights.slice(0, 2) : highlights,
            recommendedNextCalls: this.projectSummaryRecommendedCalls(normalizedScope),
            cacheUpdatedAt: cacheMeta?.updatedAt ?? null,
            cacheAgeMs: cacheMeta ? this.ageMsFromUpdatedAt(cacheMeta.updatedAt) : null
        };
        return response;
    }
    async getRelatedContext(target, budgetTokens, verbosity = "normal") {
        await this.ensureIndexWarm();
        const normalized = this.normalizeRelatedContextTarget(target);
        const effectiveBudget = Math.max(400, Math.min(Math.trunc(budgetTokens ?? 1600), 6000));
        const effectiveVerbosity = this.normalizeVerbosity(verbosity);
        const canSearchUi = this.cache.uiRootCount() > 0;
        if (normalized.kind === "path") {
            if (!this.index.pathExists(normalized.path)) {
                throw new BridgeError("not_found", `Script not found: ${normalized.path.join("/")}`, 404);
            }
            const dependencies = this.index.getDependencies(normalized.path, 1);
            const impact = this.index.getImpact(normalized.path, 1);
            const query = normalized.path[normalized.path.length - 1];
            const bundle = this.index.getContextBundle({
                entryPaths: [normalized.path],
                query,
                budgetTokens: effectiveBudget,
                dependencyDepth: 1
            });
            return {
                target: { kind: "path", value: normalized.path, resolvedPath: normalized.path },
                chunks: this.compactChunks(bundle.chunks, effectiveVerbosity),
                relatedScripts: this.mergePathReasons([
                    ...(dependencies?.nodes ?? [])
                        .filter((node) => pathKey(node.path) !== pathKey(normalized.path))
                        .map((node) => ({ path: node.path, reason: "dependency" })),
                    ...(impact?.impactedNodes ?? []).map((node) => ({ path: node.path, reason: "dependent" }))
                ], effectiveVerbosity === "minimal" ? 6 : 12),
                relatedSymbols: this.index.findSymbols({ name: query, pathPrefix: normalized.path.slice(0, -1), limit: effectiveVerbosity === "minimal" ? 4 : 10 }).slice(0, effectiveVerbosity === "minimal" ? 4 : 10),
                relatedUi: canSearchUi
                    ? (await this.searchUi(query, { limit: effectiveVerbosity === "minimal" ? 2 : 5 })).map((hit) => ({
                        path: hit.path,
                        reason: `ui_match:${hit.matchedProps.join(",") || "path"}`
                    }))
                    : [],
                usedBudget: bundle.usedBudget,
                truncated: bundle.truncated,
                recommendedNextCalls: ["rbx_get_dependencies", "rbx_get_impact", "rbx_get_script_range"]
            };
        }
        if (normalized.kind === "symbol") {
            const definition = this.index.resolveBestSymbolDefinition(normalized.symbol);
            if (!definition) {
                throw new BridgeError("not_found", `Symbol not found: ${normalized.symbol}`, 404);
            }
            const references = this.index.findReferences(normalized.symbol, { limit: 25 });
            const bundle = this.index.getContextBundle({
                entryPaths: [definition.path],
                query: normalized.symbol,
                budgetTokens: effectiveBudget,
                dependencyDepth: 1
            });
            return {
                target: { kind: "symbol", value: normalized.symbol, resolvedPath: definition.path },
                chunks: this.compactChunks(bundle.chunks, effectiveVerbosity),
                relatedScripts: this.mergePathReasons(references.map((reference) => ({
                    path: reference.path,
                    reason: reference.isDefinition ? "definition" : "reference"
                })), effectiveVerbosity === "minimal" ? 5 : 12),
                relatedSymbols: [definition, ...this.index.findSymbols({ name: normalized.symbol, limit: effectiveVerbosity === "minimal" ? 4 : 10 })].slice(0, effectiveVerbosity === "minimal" ? 4 : 10),
                relatedUi: canSearchUi
                    ? (await this.searchUi(normalized.symbol, { limit: effectiveVerbosity === "minimal" ? 2 : 5 })).map((hit) => ({
                        path: hit.path,
                        reason: `ui_match:${hit.matchedProps.join(",") || "path"}`
                    }))
                    : [],
                usedBudget: bundle.usedBudget,
                truncated: bundle.truncated,
                recommendedNextCalls: ["rbx_find_references", "rbx_get_context_bundle", "rbx_get_script_range"]
            };
        }
        const scriptHits = this.index.searchText(normalized.query, { limit: effectiveVerbosity === "minimal" ? 4 : 5 });
        const uiHits = canSearchUi ? await this.searchUi(normalized.query, { limit: effectiveVerbosity === "minimal" ? 3 : 5 }) : [];
        const bundle = this.index.getContextBundle({
            entryPaths: scriptHits.map((hit) => hit.path),
            query: normalized.query,
            budgetTokens: effectiveBudget,
            dependencyDepth: 1
        });
        return {
            target: { kind: "query", value: normalized.query, resolvedPath: scriptHits[0]?.path ?? null },
            chunks: this.compactChunks(bundle.chunks, effectiveVerbosity),
            relatedScripts: this.mergePathReasons(scriptHits.map((hit) => ({
                path: hit.path,
                reason: `text_score=${hit.score}`
            })), effectiveVerbosity === "minimal" ? 6 : 12),
            relatedSymbols: this.index.findSymbols({ name: normalized.query, limit: effectiveVerbosity === "minimal" ? 4 : 10 }).slice(0, effectiveVerbosity === "minimal" ? 4 : 10),
            relatedUi: uiHits.slice(0, effectiveVerbosity === "minimal" ? 2 : 5).map((hit) => ({
                path: hit.path,
                reason: `ui_match:${hit.matchedProps.join(",") || "path"}`
            })),
            usedBudget: bundle.usedBudget,
            truncated: bundle.truncated,
            recommendedNextCalls: ["rbx_search_text", "rbx_search_ui", "rbx_get_context_bundle"]
        };
    }
    async getUiSummary(pathInput, options = {}) {
        await this.ensureUiIndexWarm();
        const read = await this.readUiTree(pathInput, undefined, options);
        const effectiveVerbosity = this.normalizeVerbosity(options.verbosity);
        const summary = this.uiIndex.summarizeTree(read.tree.path);
        if (!summary) {
            throw new BridgeError("not_found", `UI path not found: ${read.tree.path.join("/")}`, 404);
        }
        return {
            ...summary,
            classHistogram: effectiveVerbosity === "minimal" ? summary.classHistogram.slice(0, 6) : summary.classHistogram,
            interactiveNodes: effectiveVerbosity === "minimal" ? summary.interactiveNodes.slice(0, 8) : summary.interactiveNodes,
            textNodes: effectiveVerbosity === "minimal" ? summary.textNodes.slice(0, 6) : summary.textNodes,
            layoutPrimitives: effectiveVerbosity === "minimal" ? summary.layoutPrimitives.slice(0, 6) : summary.layoutPrimitives,
            bindingHints: await this.inferUiBindingHints(summary, effectiveVerbosity),
            fromCache: read.fromCache,
            cacheAgeMs: read.cacheAgeMs,
            refreshedBeforeRead: read.refreshedBeforeRead
        };
    }
    async getUiLayoutSnapshot(pathInput, options = {}) {
        const path = normalizePath(pathInput);
        const read = await this.readUiTree(path, undefined, options);
        const result = await this.requestUiLayoutSnapshotByPath(read.tree.path);
        return {
            ...result,
            root: result?.root ? annotateLayoutFamilies(result.root) : result?.root,
            fromCache: false,
            cacheAgeMs: read.cacheAgeMs,
            refreshedBeforeRead: true
        };
    }
    async validateUiLayout(pathInput, options = {}) {
        const effectiveVerbosity = this.normalizeVerbosity(options.verbosity);
        const snapshot = await this.getUiLayoutSnapshot(pathInput, options);
        const validation = validateLayoutSnapshot(snapshot);
        return {
            path: snapshot.root?.path ?? normalizePath(pathInput),
            issues: effectiveVerbosity === "minimal" ? validation.summary.topIssues : validation.issues,
            summary: validation.summary,
            partialGeometryOnly: snapshot.partialGeometryOnly === true,
            fromCache: snapshot.fromCache,
            cacheAgeMs: snapshot.cacheAgeMs,
            refreshedBeforeRead: snapshot.refreshedBeforeRead
        };
    }
    explainError(code, details) {
        return explainBridgeError(code, details);
    }
    async getScriptRange(pathInput, startLine, endLine, options = {}) {
        const readResult = await this.readScript(pathInput, options);
        await this.ensureIndexWarm();
        const range = this.index.getScriptRange(readResult.script.path, startLine, endLine);
        if (!range) {
            return null;
        }
        return {
            ...range,
            fromCache: readResult.fromCache,
            cacheAgeMs: readResult.cacheAgeMs,
            refreshedBeforeRead: readResult.refreshedBeforeRead
        };
    }
    async getDependencies(pathInput, depth = 1) {
        await this.ensureIndexWarm();
        return this.index.getDependencies(pathInput, depth);
    }
    async getImpact(pathInput, depth = 1) {
        await this.ensureIndexWarm();
        return this.index.getImpact(pathInput, depth);
    }
    async refreshScripts(pathsInput) {
        if (!Array.isArray(pathsInput)) {
            throw new BridgeError("invalid_paths", "paths must be an array", 400);
        }
        const uniqueByKey = new Map();
        for (const rawPath of pathsInput) {
            const path = normalizePath(rawPath);
            uniqueByKey.set(pathKey(path), path);
        }
        const paths = [...uniqueByKey.values()];
        if (paths.length === 0) {
            return { refreshed: 0, failed: 0, errors: [], items: [] };
        }
        const errors = [];
        const failedKeys = new Set();
        try {
            await this.requestSnapshotByPaths(paths);
        }
        catch (error) {
            if (!(error instanceof BridgeError) || error.code !== "unsupported_command") {
                throw error;
            }
            for (const path of paths) {
                try {
                    await this.requestSnapshotByPath(path);
                }
                catch (fallbackError) {
                    if (fallbackError instanceof BridgeError) {
                        errors.push({ path, code: fallbackError.code, message: fallbackError.message });
                    }
                    else if (fallbackError instanceof Error) {
                        errors.push({ path, code: "refresh_failed", message: fallbackError.message });
                    }
                    else {
                        errors.push({ path, code: "refresh_failed", message: String(fallbackError) });
                    }
                    failedKeys.add(pathKey(path));
                }
            }
        }
        const items = [];
        for (const path of paths) {
            if (failedKeys.has(pathKey(path))) {
                continue;
            }
            const script = await this.cache.getScript(path);
            if (script) {
                items.push(script);
            }
            else {
                errors.push({ path, code: "not_found", message: "Script not found after refresh" });
                failedKeys.add(pathKey(path));
            }
        }
        return {
            refreshed: items.length,
            failed: errors.length,
            errors,
            items
        };
    }
    async updateUi(pathInput, expectedVersion, props, clearProps, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const path = normalizePath(pathInput);
        const clearList = Array.isArray(clearProps) ? clearProps : [];
        const current = await this.refreshUiTree(path);
        if (current.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before write", 409, {
                expectedVersion,
                currentVersion: current.version
            });
        }
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath: path,
            expectedVersion: current.version,
            operations: [
                {
                    op: "update_props",
                    path,
                    props,
                    clearProps: clearList
                }
            ]
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        const updated = await this.refreshUiTree(path);
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path: updated.path, updatedAt: updated.updatedAt }]);
        return updated;
    }
    async updateUiMetadata(pathInput, expectedVersion, metadataInput, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const path = normalizePath(pathInput);
        const current = await this.refreshUiTree(path);
        if (current.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before metadata write", 409, {
                expectedVersion,
                currentVersion: current.version
            });
        }
        const metadata = metadataInput && typeof metadataInput === "object" ? metadataInput : {};
        const tagPatch = normalizeMetadataTagPatch(current.tags, metadata);
        const expectedTags = tagPatch.expectedTags;
        const expectedAttributes = applyMetadataPatchToAttributes(current.attributes, metadata);
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath: path,
            expectedVersion: current.version,
            operations: [
                {
                    op: "update_metadata",
                    path,
                    addTags: tagPatch.addTags,
                    removeTags: tagPatch.removeTags,
                    attributes: normalizeAttributesMap(metadata.attributes),
                    clearAttributes: Array.isArray(metadata.clearAttributes) ? metadata.clearAttributes.map((entry) => String(entry)) : []
                }
            ]
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        const updated = await this.refreshUiTree(path);
        const actualTags = normalizeTagList(updated.tags);
        const actualAttributes = normalizeAttributesMap(updated.attributes);
        if (stableJson(actualTags) !== stableJson(expectedTags) || !sameMetadataAttributes(actualAttributes, expectedAttributes)) {
            throw buildMetadataVerificationError("ui", updated.path, expectedTags, actualTags, expectedAttributes, actualAttributes);
        }
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path: updated.path, updatedAt: updated.updatedAt }]);
        return updated;
    }
    async createUi(parentPathInput, className, name, props = {}, index, placeId, metadataInput = {}) {
        this.assertUiMutationsAllowed(placeId);
        const parentPath = normalizePath(parentPathInput);
        const parent = await this.refreshUiTree(parentPath);
        if (parent.children.some((child) => child.name === name)) {
            throw new BridgeError("already_exists", `UI node already exists: ${[...parentPath, name].join("/")}`, 409, {
                path: [...parentPath, name]
            });
        }
        const metadata = metadataInput && typeof metadataInput === "object" ? metadataInput : {};
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath: parentPath,
            expectedVersion: parent.version,
            operations: [
                {
                    op: "create_node",
                    parentPath,
                    className,
                    name,
                    props,
                    tags: normalizeTagList(metadata.tags ?? metadata.addTags),
                    attributes: normalizeAttributesMap(metadata.attributes),
                    index
                }
            ]
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        const created = await this.refreshUiTree([...parentPath, name]);
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path: created.path, updatedAt: created.updatedAt }]);
        return created;
    }
    async applyUiBatch(rootPathInput, expectedVersion, operationsInput, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const rootPath = normalizePath(rootPathInput);
        if (!Array.isArray(operationsInput) || operationsInput.length === 0) {
            throw new BridgeError("invalid_ui_operation", "operations must be a non-empty array", 400);
        }
        const current = await this.refreshUiTree(rootPath);
        if (current.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before batch", 409, {
                expectedVersion,
                currentVersion: current.version
            });
        }
        const operations = operationsInput.map((operation) => normalizeUiBatchOperation(operation));
        const resolved = resolveUiOperationRefs(rootPath, operations);
        for (const operation of resolved.operations) {
            ensureUiOperationWithinRoot(rootPath, operation);
        }
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath,
            expectedVersion: current.version,
            operations: resolved.operations
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        const root = await this.refreshUiTree(rootPath);
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path: root.path, updatedAt: root.updatedAt }]);
        return {
            root,
            version: root.version,
            updatedAt: root.updatedAt,
            appliedCount: resolved.operations.length,
            operations: resolved.operations,
            resolvedRefs: resolved.resolvedRefs
        };
    }
    async deleteUi(pathInput, expectedVersion, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const path = normalizePath(pathInput);
        const current = await this.refreshUiTree(path);
        if (current.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before delete", 409, {
                expectedVersion,
                currentVersion: current.version
            });
        }
        const parentPath = path.length > 1 ? path.slice(0, -1) : null;
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath: path,
            expectedVersion: current.version,
            operations: [
                {
                    op: "delete_node",
                    path
                }
            ]
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        let parentVersion = null;
        if (parentPath) {
            try {
                parentVersion = (await this.refreshUiTree(parentPath)).version;
            }
            catch {
                parentVersion = null;
            }
        }
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path, updatedAt: nowIso() }]);
        return { deletedPath: path, parentPath, parentVersion };
    }
    async moveUi(pathInput, newParentPathInput, index, expectedVersion, placeId) {
        this.assertUiMutationsAllowed(placeId);
        const path = normalizePath(pathInput);
        const newParentPath = normalizePath(newParentPathInput);
        const current = await this.refreshUiTree(path);
        if (current.version !== expectedVersion) {
            throw new BridgeError("version_conflict", "UI version mismatch before move", 409, {
                expectedVersion,
                currentVersion: current.version
            });
        }
        await this.queue.enqueue("mutate_ui_batch_if_version", {
            rootPath: path,
            expectedVersion: current.version,
            operations: [
                {
                    op: "move_node",
                    path,
                    newParentPath,
                    index
                }
            ]
        }, COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version);
        const moved = await this.refreshUiTree([...newParentPath, current.name]);
        await this.cache.recordChangedItems("ui_root", "ui_write", [{ path: moved.path, updatedAt: moved.updatedAt }]);
        return moved;
    }
    getLogs(cursor, limitInput, minLevelInput, requestId: string | undefined = undefined, sinceTime: string | undefined = undefined, untilTime: string | undefined = undefined) {
        const limit = Math.max(1, Math.min(Math.trunc(limitInput ?? 100), 500));
        const minLevel = LOG_LEVELS.has(minLevelInput ?? "info") ? (minLevelInput ?? "info") : "info";
        const minPriority = levelPriority(minLevel);
        const afterCursor = cursor ? Number.parseInt(cursor, 10) : 0;
        const sinceMs = typeof sinceTime === "string" && sinceTime ? Date.parse(sinceTime) : null;
        const untilMs = typeof untilTime === "string" && untilTime ? Date.parse(untilTime) : null;
        const filtered = this.logEntries.filter((entry) => {
            const entryCursor = Number.parseInt(entry.cursor, 10);
            const entryTimeMs = Date.parse(entry.time);
            if (entryCursor <= afterCursor || levelPriority(entry.level) < minPriority) {
                return false;
            }
            if (requestId && entry.requestId !== requestId) {
                return false;
            }
            if (sinceMs !== null && Number.isFinite(sinceMs) && entryTimeMs < sinceMs) {
                return false;
            }
            if (untilMs !== null && Number.isFinite(untilMs) && entryTimeMs > untilMs) {
                return false;
            }
            return true;
        });
        const items = filtered.slice(0, limit);
        return {
            items,
            nextCursor: items.length > 0 ? items[items.length - 1].cursor : cursor ?? null,
            logBufferSize: this.logEntries.length,
            lastLogAt: this.lastLogAt,
            lastCapturedAt: this.lastLogAt,
            logsStale: this.lastLogAt ? nowMs() - Date.parse(this.lastLogAt) > 120_000 : true
        };
    }
    createTrace(requestId, transport, endpoint, toolName: string | undefined = undefined) {
        const trace = this.traceStore.start(requestId, transport, endpoint, toolName);
        const active = this.liveSession();
        const cacheMeta = this.cache.metadata();
        trace.setSessionSnapshot({
            sessionId: active?.sessionId ?? null,
            placeId: active?.placeId ?? cacheMeta?.placeId ?? null,
            placeName: active?.placeName ?? cacheMeta?.placeName ?? null,
            pluginVersion: active?.pluginVersion ?? null,
            studioOnline: Boolean(active)
        });
        return trace;
    }
    liveSession() {
        const active = this.sessions.active();
        if (!active) {
            return null;
        }
        return sessionAgeMs(active) <= SESSION_STALE_AFTER_MS ? active : null;
    }
    getRequestTrace(requestId) {
        return this.traceStore.get(requestId);
    }
    async getScriptMetadata(pathInput, options = {}) {
        const read = await this.readScript(pathInput, options);
        return {
            path: read.script.path,
            resolvedPath: read.script.path,
            resolvedPathSegments: [...read.script.path],
            hash: read.script.hash,
            size: read.script.source.length,
            updatedAt: read.script.updatedAt,
            draftAware: read.script.draftAware,
            readChannel: read.script.readChannel,
            tags: [...read.script.tags],
            attributes: { ...read.script.attributes },
            fromCache: read.fromCache,
            cacheAgeMs: read.cacheAgeMs,
            refreshedBeforeRead: read.refreshedBeforeRead
        };
    }
    async getScripts(pathsInput, options = {}) {
        if (!Array.isArray(pathsInput)) {
            throw new BridgeError("invalid_payload", "paths must be an array", 400);
        }
        const items = [];
        for (const pathInput of pathsInput) {
            try {
                const read = await this.readScript(pathInput, options);
                items.push({
                    ok: true,
                    path: read.script.path,
                    resolvedPath: read.script.path,
                    resolvedPathSegments: [...read.script.path],
                    source: options.includeSource === false ? undefined : read.script.source,
                    hash: read.script.hash,
                    updatedAt: read.script.updatedAt,
                    draftAware: read.script.draftAware,
                    readChannel: read.script.readChannel,
                    tags: [...read.script.tags],
                    attributes: { ...read.script.attributes },
                    fromCache: read.fromCache,
                    cacheAgeMs: read.cacheAgeMs,
                    refreshedBeforeRead: read.refreshedBeforeRead
                });
            }
            catch (error) {
                items.push({
                    ok: false,
                    path: Array.isArray(pathInput) ? pathInput : pathInput,
                    error: error instanceof BridgeError
                        ? { code: error.code, message: error.message, details: error.details ?? null }
                        : { code: "internal", message: error instanceof Error ? error.message : String(error) }
                });
            }
        }
        return {
            items,
            count: items.length
        };
    }
    health() {
        const active = this.liveSession();
        const rawActive = this.sessions.active();
        const cacheMeta = this.cache.metadata();
        const activePlaceId = active?.placeId ?? cacheMeta?.placeId ?? null;
        const activePlaceName = active?.placeName ?? cacheMeta?.placeName ?? null;
        const publicSession = rawActive
            ? {
                sessionId: rawActive.sessionId,
                clientId: rawActive.clientId,
                placeId: rawActive.placeId,
                placeName: rawActive.placeName,
                pluginVersion: rawActive.pluginVersion,
                connectedAt: rawActive.connectedAt,
                lastSeenAt: rawActive.lastSeenAt,
                lastPollAt: rawActive.lastPollAt,
                stale: sessionAgeMs(rawActive) > SESSION_STALE_AFTER_MS,
                staleAgeMs: sessionAgeMs(rawActive)
            }
            : null;
        const bridgeBaseUrl = `http://${this.options.bridgeHost}:${this.options.bridgePort}`;
        return {
            ok: true,
            startupAt: this.startup,
            now: new Date().toISOString(),
            projectAlias: this.options.projectAlias || null,
            mode: "one_port_one_project_one_session",
            bridge: {
                host: this.options.bridgeHost,
                port: this.options.bridgePort,
                baseUrl: bridgeBaseUrl
            },
            expectedPlaceId: this.options.expectedPlaceId || null,
            studioOnline: Boolean(active),
            scriptReadOk: Boolean(active),
            scriptWriteOk: Boolean(active && (active.editorApiAvailable === true || cacheMeta?.editorApiAvailable === true)),
            uiWriteOk: Boolean(active),
            logCaptureFresh: Boolean(active?.logCaptureAvailable && this.lastLogAt && nowMs() - Date.parse(this.lastLogAt) <= 120_000),
            draftMode: "draft_only",
            session: publicSession,
            draft: {
                writeMode: "draft_only",
                editorApiAvailable: active?.editorApiAvailable ?? cacheMeta?.editorApiAvailable ?? null,
                base64Transport: active?.base64Transport ?? false,
                lastReadChannel: cacheMeta?.lastReadChannel ?? null,
                lastWriteChannel: this.lastWriteChannel ?? cacheMeta?.lastWriteChannel ?? null
            },
            uiSupported: true,
            logCaptureAvailable: active?.logCaptureAvailable ?? null,
            logBufferSize: this.logEntries.length,
            lastLogAt: this.lastLogAt,
            commandTimeoutsMs: {
                default: COMMAND_TIMEOUTS_MS.default,
                snapshotAllScripts: COMMAND_TIMEOUTS_MS.snapshot_all_scripts,
                snapshotScriptByPath: COMMAND_TIMEOUTS_MS.snapshot_script_by_path,
                snapshotScriptsByPaths: COMMAND_TIMEOUTS_MS.snapshot_scripts_by_paths,
                setScriptSourceIfHash: COMMAND_TIMEOUTS_MS.set_script_source_if_hash,
                upsertScript: COMMAND_TIMEOUTS_MS.upsert_script,
                deleteScriptIfHash: COMMAND_TIMEOUTS_MS.delete_script_if_hash,
                moveScriptIfHash: COMMAND_TIMEOUTS_MS.move_script_if_hash,
                snapshotUiRoots: COMMAND_TIMEOUTS_MS.snapshot_ui_roots,
                snapshotUiSubtreeByPath: COMMAND_TIMEOUTS_MS.snapshot_ui_subtree_by_path,
                snapshotUiLayoutByPath: COMMAND_TIMEOUTS_MS.snapshot_ui_layout_by_path,
                mutateUiBatchIfVersion: COMMAND_TIMEOUTS_MS.mutate_ui_batch_if_version
            },
            cache: {
                placeId: activePlaceId,
                placeName: activePlaceName,
                updatedAt: cacheMeta?.updatedAt ?? null,
                writeMode: cacheMeta?.writeMode ?? "draft_only",
                scriptCount: cacheMeta ? this.cache.scriptCount() : 0,
                uiRootCount: cacheMeta ? this.cache.uiRootCount() : 0,
                ageMs: cacheMeta ? Math.max(0, nowMs() - Date.parse(cacheMeta.updatedAt)) : null,
                lastReadChannel: cacheMeta?.lastReadChannel ?? null,
                lastWriteChannel: this.lastWriteChannel ?? cacheMeta?.lastWriteChannel ?? null,
                indexVersion: cacheMeta?.indexVersion ?? null,
                indexUpdatedAt: cacheMeta?.indexUpdatedAt ?? null,
                uiIndexVersion: cacheMeta?.uiIndexVersion ?? null,
                uiIndexUpdatedAt: cacheMeta?.uiIndexUpdatedAt ?? null
            },
            index: {
                scriptCount: this.index.scriptCount(),
                uiRootCount: this.uiIndex.rootCount()
            },
            admin: {
                upsertEnabled: this.options.adminMutationsEnabled
            }
        };
    }
    capabilities() {
        const health = this.health();
        return {
            ok: true,
            projectAlias: health.projectAlias ?? null,
            mode: "one_port_one_project_one_session",
            bridge: health.bridge,
            activeProject: {
                placeId: health.cache?.placeId ?? null,
                placeName: health.cache?.placeName ?? null,
                studioOnline: health.studioOnline ?? false
            },
            readiness: {
                scriptReadOk: health.scriptReadOk,
                scriptWriteOk: health.scriptWriteOk,
                uiWriteOk: health.uiWriteOk,
                logCaptureFresh: health.logCaptureFresh,
                draftMode: health.draftMode
            },
            writePolicy: {
                mode: "hash_locked",
                createOnly: true,
                adminUpsertEnabled: this.options.adminMutationsEnabled
            },
            defaults: {
                read: {
                    forceRefresh: false,
                    maxAgeMs: this.options.defaultReadMaxAgeMs
                }
            },
            preferredBootstrapParams: {
                verbosity: "minimal"
            },
            ui: {
                supportedRoots: ["StarterGui", "Workspace/*Gui", "SurfaceGui", "BillboardGui", "LayerCollector"],
                createPolicy: "strict_ui_only",
                preferredMutationMode: "batch",
                mutationPolicy: "version_locked_batch",
                propertyCodecTypes: ["string", "number", "boolean", "Color3", "UDim", "UDim2", "Vector2", "Enum", "ColorSequence", "NumberSequence", "Rect"],
                commonErrors: [
                    "ui_class_not_supported",
                    "path_blocked_by_non_ui_child",
                    "name_occupied_by_non_ui_child",
                    "version_conflict",
                    "batch_operation_failed"
                ],
                layoutDiagnosticsSupported: "edit_time_only"
            },
            bindings: {
                mode: "heuristic"
            },
            remoteGraph: {
                mode: "static_heuristic_v2"
            },
            logs: {
                cursorSupport: true,
                levels: ["info", "warn", "error"],
                retention: LOG_BUFFER_LIMIT
            },
            preferredBootstrapCalls: [
                "GET /v1/agent/capabilities",
                "GET /v1/agent/schema",
                "POST /v1/agent/health",
                "POST /v1/agent/get_project_summary"
            ],
            bootstrapWorkflow: [
                "capabilities -> schema -> health -> get_project_summary -> targeted retrieval"
            ],
            recommendedNextStepByError: recommendedNextStepByError(),
            modelWaitPolicy: heavyOperationPolicy(),
            gotchas: [
                "All public paths are slash-delimited strings.",
                "get_related_context.target must be an object.",
                "apply_script_patch.patch must be an array of operations.",
                "search_text is lexical, not semantic.",
                "For heavy operations, do not wait longer than 30 seconds; inspect requestId via get_request_trace."
            ],
            operations: {
                tools: [
                    "rbx_health",
                    "rbx_schema",
                    "rbx_list_scripts",
                    "rbx_get_script",
                    "rbx_get_script_metadata",
                    "rbx_get_scripts",
                    "rbx_refresh_script",
                    "rbx_update_script",
                    "rbx_create_script",
                    "rbx_delete_script",
                    "rbx_move_script",
                    "rbx_get_project_summary",
                    "rbx_get_related_context",
                    "rbx_get_ui_summary",
                    "rbx_get_ui_layout_snapshot",
                    "rbx_validate_ui_layout",
                    "rbx_explain_error",
                    "rbx_validate_payload",
                    "rbx_validate_operation",
                    "rbx_get_request_trace",
                    "rbx_apply_script_patch",
                    "rbx_diff_script",
                    "rbx_find_entrypoints",
                    "rbx_find_remotes",
                    "rbx_find_ui_bindings",
                    "rbx_rank_files_by_relevance",
                    "rbx_get_changed_since",
                    "rbx_get_symbol_context",
                    "rbx_search_text",
                    "rbx_find_symbols",
                    "rbx_find_references",
                    "rbx_get_context_bundle",
                    "rbx_get_script_range",
                    "rbx_get_dependencies",
                    "rbx_get_impact",
                    "rbx_refresh_scripts",
                    "rbx_list_ui_roots",
                    "rbx_get_ui_tree",
                    "rbx_search_ui",
                    "rbx_apply_ui_batch",
                    "rbx_clone_ui_subtree",
                    "rbx_apply_ui_template",
                    "rbx_update_ui",
                    "rbx_create_ui",
                    "rbx_delete_ui",
                    "rbx_move_ui",
                    "rbx_get_logs"
                ],
                agentHttp: [
                    "GET /v1/agent/capabilities",
                    "GET /v1/agent/schema",
                    "POST /v1/agent/health",
                    "POST /v1/agent/list_scripts",
                    "POST /v1/agent/get_script",
                    "POST /v1/agent/get_script_metadata",
                    "POST /v1/agent/get_scripts",
                    "POST /v1/agent/refresh_script",
                    "POST /v1/agent/update_script",
                    "POST /v1/agent/create_script",
                    "POST /v1/agent/delete_script",
                    "POST /v1/agent/move_script",
                    "POST /v1/agent/get_project_summary",
                    "POST /v1/agent/get_related_context",
                    "POST /v1/agent/get_ui_summary",
                    "POST /v1/agent/get_ui_layout_snapshot",
                    "POST /v1/agent/validate_ui_layout",
                    "POST /v1/agent/explain_error",
                    "POST /v1/agent/validate_payload",
                    "POST /v1/agent/validate_operation",
                    "POST /v1/agent/get_request_trace",
                    "POST /v1/agent/apply_script_patch",
                    "POST /v1/agent/diff_script",
                    "POST /v1/agent/find_entrypoints",
                    "POST /v1/agent/find_remotes",
                    "POST /v1/agent/find_ui_bindings",
                    "POST /v1/agent/rank_files_by_relevance",
                    "POST /v1/agent/get_changed_since",
                    "POST /v1/agent/get_symbol_context",
                    "POST /v1/agent/search_text",
                    "POST /v1/agent/find_symbols",
                    "POST /v1/agent/find_references",
                    "POST /v1/agent/get_context_bundle",
                    "POST /v1/agent/get_script_range",
                    "POST /v1/agent/get_dependencies",
                    "POST /v1/agent/get_impact",
                    "POST /v1/agent/refresh_scripts",
                    "POST /v1/agent/list_ui_roots",
                    "POST /v1/agent/get_ui_tree",
                    "POST /v1/agent/search_ui",
                    "POST /v1/agent/apply_ui_batch",
                    "POST /v1/agent/clone_ui_subtree",
                    "POST /v1/agent/apply_ui_template",
                    "POST /v1/agent/update_ui",
                    "POST /v1/agent/create_ui",
                    "POST /v1/agent/delete_ui",
                    "POST /v1/agent/move_ui",
                    "POST /v1/agent/get_logs"
                ]
            },
            contracts: {
                updateScript: {
                    endpoint: "/v1/agent/update_script",
                    required: ["path", "newSource", "expectedHash"],
                    optional: ["placeId"]
                },
                createScript: {
                    endpoint: "/v1/agent/create_script",
                    required: ["path"],
                    optional: ["className", "source", "placeId"]
                },
                deleteScript: {
                    endpoint: "/v1/agent/delete_script",
                    required: ["path", "expectedHash"],
                    optional: ["placeId"]
                },
                moveScript: {
                    endpoint: "/v1/agent/move_script",
                    required: ["path", "newParentPath", "expectedHash"],
                    optional: ["newName", "placeId"]
                },
                getScript: {
                    endpoint: "/v1/agent/get_script",
                    required: ["path"],
                    optional: ["forceRefresh", "maxAgeMs"]
                },
                getProjectSummary: {
                    endpoint: "/v1/agent/get_project_summary",
                    required: [],
                    optional: ["scope", "service", "verbosity"]
                },
                getRelatedContext: {
                    endpoint: "/v1/agent/get_related_context",
                    required: ["target"],
                    optional: ["budgetTokens", "verbosity"]
                },
                getUiSummary: {
                    endpoint: "/v1/agent/get_ui_summary",
                    required: ["path"],
                    optional: ["forceRefresh", "maxAgeMs", "verbosity"]
                },
                getUiLayoutSnapshot: {
                    endpoint: "/v1/agent/get_ui_layout_snapshot",
                    required: ["path"],
                    optional: ["forceRefresh", "maxAgeMs"]
                },
                validateUiLayout: {
                    endpoint: "/v1/agent/validate_ui_layout",
                    required: ["path"],
                    optional: ["forceRefresh", "maxAgeMs", "verbosity"]
                },
                explainError: {
                    endpoint: "/v1/agent/explain_error",
                    required: ["code"],
                    optional: ["details"]
                },
                validateOperation: {
                    endpoint: "/v1/agent/validate_operation",
                    required: ["kind", "payload"],
                    optional: []
                },
                applyScriptPatch: {
                    endpoint: "/v1/agent/apply_script_patch",
                    required: ["path", "expectedHash", "patch"],
                    optional: ["placeId"]
                },
                diffScript: {
                    endpoint: "/v1/agent/diff_script",
                    required: ["path"],
                    optional: ["baseHash", "forceRefresh", "maxAgeMs"]
                },
                findEntrypoints: {
                    endpoint: "/v1/agent/find_entrypoints",
                    required: [],
                    optional: ["query", "service", "limit", "verbosity"]
                },
                findRemotes: {
                    endpoint: "/v1/agent/find_remotes",
                    required: [],
                    optional: ["query", "limit", "verbosity"]
                },
                findUiBindings: {
                    endpoint: "/v1/agent/find_ui_bindings",
                    required: ["target"],
                    optional: ["limit"]
                },
                rankFilesByRelevance: {
                    endpoint: "/v1/agent/rank_files_by_relevance",
                    required: ["query"],
                    optional: ["limit", "verbosity"]
                },
                getChangedSince: {
                    endpoint: "/v1/agent/get_changed_since",
                    required: ["cursorOrTimestamp"],
                    optional: ["limit"]
                },
                getSymbolContext: {
                    endpoint: "/v1/agent/get_symbol_context",
                    required: ["symbol"],
                    optional: ["budgetTokens", "verbosity"]
                },
                updateUi: {
                    endpoint: "/v1/agent/update_ui",
                    required: ["path", "expectedVersion", "props"],
                    optional: ["clearProps", "placeId"]
                },
                createUi: {
                    endpoint: "/v1/agent/create_ui",
                    required: ["parentPath", "className", "name"],
                    optional: ["props", "index", "placeId"]
                },
                applyUiBatch: {
                    endpoint: "/v1/agent/apply_ui_batch",
                    required: ["rootPath", "expectedVersion", "operations"],
                    optional: ["placeId"]
                },
                cloneUiSubtree: {
                    endpoint: "/v1/agent/clone_ui_subtree",
                    required: ["rootPath", "sourcePath", "newParentPath", "expectedVersion"],
                    optional: ["newName", "placeId"]
                },
                applyUiTemplate: {
                    endpoint: "/v1/agent/apply_ui_template",
                    required: ["kind", "rootPath", "targetPath", "expectedVersion", "options"],
                    optional: ["placeId"]
                },
                moveUi: {
                    endpoint: "/v1/agent/move_ui",
                    required: ["path", "newParentPath", "expectedVersion"],
                    optional: ["index", "placeId"]
                },
                getLogs: {
                    endpoint: "/v1/agent/get_logs",
                    required: [],
                    optional: ["cursor", "limit", "minLevel"]
                }
            },
            recommendedWorkflows: {
                scriptEdit: [
                    "search_text -> get_script(forceRefresh=true) -> update_script(expectedHash)",
                    "on hash_conflict: get_script(forceRefresh=true) -> retry update"
                ],
                scriptTreeEdit: [
                    "get_script(forceRefresh=true) -> validate_operation(script_move|script_delete) -> move_script/delete_script"
                ],
                projectNavigation: [
                    "get_project_summary(verbosity=minimal) -> find_entrypoints -> rank_files_by_relevance"
                ],
                symbolDebug: [
                    "get_symbol_context -> get_related_context(path)"
                ],
                scriptPatchReview: [
                    "validate_operation(script_patch) -> apply_script_patch -> diff_script"
                ],
                uiEdit: [
                    "search_ui -> get_ui_tree(forceRefresh=true) -> apply_ui_batch(expectedVersion)",
                    "for small edits: search_ui -> get_ui_tree(forceRefresh=true) -> update_ui(expectedVersion)"
                ],
                uiClone: [
                    "get_ui_tree(forceRefresh=true) -> validate_operation(ui_clone) -> clone_ui_subtree"
                ],
                layoutDiagnostics: [
                    "get_ui_layout_snapshot -> validate_ui_layout"
                ],
                uiBindingDiscovery: [
                    "get_ui_summary -> find_ui_bindings"
                ],
                uiTemplate: [
                    "get_ui_tree(forceRefresh=true) -> validate_operation(ui_template) -> apply_ui_template"
                ]
            }
        };
    }
    cacheTransparency() {
        const cacheMeta = this.cache.metadata();
        return {
            cacheUpdatedAt: cacheMeta?.updatedAt ?? null,
            cacheAgeMs: cacheMeta ? this.ageMsFromUpdatedAt(cacheMeta.updatedAt) : null
        };
    }
    isAdminMutationsEnabled() {
        return this.options.adminMutationsEnabled;
    }
    async triggerSnapshotAll() {
        await this.requestSnapshotAll();
    }
    async requestSnapshotAll() {
        await this.queue.enqueue("snapshot_all_scripts", {}, COMMAND_TIMEOUTS_MS.snapshot_all_scripts);
    }
    async requestUiSnapshotAll() {
        await this.queue.enqueue("snapshot_ui_roots", {}, COMMAND_TIMEOUTS_MS.snapshot_ui_roots);
    }
    async requestSnapshotByPath(path, trace) {
        const queued = this.queue.enqueueDetailed("snapshot_script_by_path", {
            path,
            key: pathKey(path),
            requestId: trace?.requestId
        }, COMMAND_TIMEOUTS_MS.snapshot_script_by_path);
        trace?.noteCommand(queued.command.commandId, queued.command.type);
        await queued.result;
    }
    async requestUiSnapshotByPath(path) {
        await this.queue.enqueue("snapshot_ui_subtree_by_path", {
            path,
            key: pathKey(path)
        }, COMMAND_TIMEOUTS_MS.snapshot_ui_subtree_by_path);
    }
    async requestUiLayoutSnapshotByPath(path) {
        return await this.queue.enqueue("snapshot_ui_layout_by_path", {
            path,
            key: pathKey(path)
        }, COMMAND_TIMEOUTS_MS.snapshot_ui_layout_by_path);
    }
    async requestSnapshotByPaths(paths) {
        await this.queue.enqueue("snapshot_scripts_by_paths", {
            paths,
            keys: paths.map((entry) => pathKey(entry))
        }, COMMAND_TIMEOUTS_MS.snapshot_scripts_by_paths);
    }
    async ensureIndexWarm() {
        await this.ensureCacheWarm();
        const placeId = this.cache.getActivePlaceId();
        if (!placeId) {
            return;
        }
        await this.index.switchPlace(placeId);
        if (this.index.scriptCount() === 0 && this.cache.scriptCount() > 0) {
            await this.index.fullRebuildFromCache();
        }
    }
    async ensureUiIndexWarm() {
        await this.ensureUiCacheWarm();
        const placeId = this.cache.getActivePlaceId();
        if (!placeId) {
            return;
        }
        await this.uiIndex.switchPlace(placeId);
        if (this.uiIndex.rootCount() === 0 && this.cache.uiRootCount() > 0) {
            await this.uiIndex.fullRebuildFromCache();
        }
    }
    normalizeVerbosity(value) {
        return value === "minimal" ? "minimal" : "normal";
    }
    compactChunk(chunk, verbosity) {
        if (verbosity !== "minimal") {
            return chunk;
        }
        const lines = String(chunk.content ?? "").split(/\r?\n/);
        const compactLines = lines.length > 10 ? lines.slice(0, 6) : lines;
        return {
            ...chunk,
            content: compactLines.join("\n"),
            omittedBefore: chunk.omittedBefore ?? 0,
            omittedAfter: Math.max(0, lines.length - compactLines.length)
        };
    }
    compactChunks(chunks, verbosity) {
        const mapped = chunks.map((chunk) => this.compactChunk(chunk, verbosity));
        return verbosity === "minimal" ? mapped.slice(0, 4) : mapped;
    }
    trimReasons(items, maxReasons) {
        return items.map((item) => ({
            ...item,
            reasons: Array.isArray(item.reasons) ? [...new Set(item.reasons)].slice(0, maxReasons) : item.reasons
        }));
    }
    trimStrings(items, limit) {
        return [...new Set((items ?? []).filter(Boolean))].slice(0, limit);
    }
    addRecovery(details, code) {
        const guidance = this.explainError(code, details);
        return {
            ...(details && typeof details === "object" ? details : {}),
            recovery: guidance.recommendedNextCall
        };
    }
    scriptLooksLikeUiController(script, source) {
        return script.className === "LocalScript"
            && /(mousebutton1click|activated|focuslost|playergui|startergui|screengui|waitforchild)/i.test(source);
    }
    normalizeNameToken(value) {
        return String(value ?? "")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_\-]+/g, " ")
            .replace(/[^\p{L}\p{N}\s]+/gu, " ")
            .toLowerCase()
            .split(/\s+/)
            .filter((part) => part.length >= 3);
    }
    isGenericUiUtilityPath(path) {
        const text = path.join("/").toLowerCase();
        return /(util|utils|config|constants|shared|common|theme|styles?)/.test(text);
    }
    isExternalUiPackagePath(path) {
        const text = path.join("/").toLowerCase();
        return /(^|\/)(_index|packages)(\/|$)|topbarplus|matter|sleitnick|package/.test(text);
    }
    collectUiTargetSignals(tree) {
        const ignoredNames = new Set([
            "autoscale", "corner", "stroke", "gradient", "iconwrap", "holder", "container", "shadow", "padding",
            "button", "buttons", "name", "player", "icon", "frame", "main", "bar", "left", "right", "top", "bottom",
            "background", "notifications", "notification", "label", "text", "image"
        ]);
        const collectedNodes = [];
        const visit = (node, depth) => {
            if (!node || depth > 2) {
                return;
            }
            collectedNodes.push(node);
            for (const child of node.children ?? []) {
                visit(child, depth + 1);
            }
        };
        visit(tree, 0);
        const uiNames = [...new Set(collectedNodes
                .slice(0, 24)
                .map((node) => node.name)
                .filter((name) => Boolean(name) && !ignoredNames.has(String(name).toLowerCase())))];
        const queryTokens = new Set();
        for (const name of uiNames) {
            for (const token of this.normalizeNameToken(name)) {
                if (!ignoredNames.has(token)) {
                    queryTokens.add(token);
                }
            }
        }
        for (const child of collectedNodes) {
            if (looksInteractive(child.className)) {
                for (const token of this.normalizeNameToken(child.name)) {
                    if (!ignoredNames.has(token)) {
                        queryTokens.add(token);
                    }
                }
            }
        }
        return {
            uiNames,
            queryTokens: [...queryTokens].slice(0, 12)
        };
    }
    scoreUiBindingCandidate(uiTree, script) {
        const source = script.source ?? "";
        const signals = this.collectUiTargetSignals(uiTree);
        let score = 0;
        let specificSignalCount = 0;
        const reasons = [];
        const matchedSignals = [];
        const matchedSymbols = [];
        const uiNameTokens = new Set(signals.queryTokens);
        const rootNameTokens = new Set(this.normalizeNameToken(uiTree.name));
        const scriptNameTokens = new Set(this.normalizeNameToken(script.name));
        const sharedRootTokens = [...rootNameTokens].filter((token) => scriptNameTokens.has(token));
        const sharedTokens = [...uiNameTokens].filter((token) => scriptNameTokens.has(token));
        if (sharedRootTokens.length > 0) {
            score += 7 + sharedRootTokens.length * 2;
            specificSignalCount += sharedRootTokens.length;
            reasons.push(`root_name_parity:${sharedRootTokens.join(",")}`);
            matchedSymbols.push(...sharedRootTokens);
        }
        if (sharedTokens.length > 0) {
            score += 2 + Math.min(3, sharedTokens.length);
            specificSignalCount += sharedTokens.length;
            reasons.push(`name_parity:${sharedTokens.join(",")}`);
            matchedSymbols.push(...sharedTokens);
        }
        for (const name of signals.uiNames) {
            if (source.includes(`WaitForChild("${name}")`) || source.includes(`WaitForChild('${name}')`)) {
                score += 7;
                specificSignalCount += 1;
                reasons.push(`wait_for_child:${name}`);
                matchedSignals.push("WaitForChild");
                matchedSymbols.push(name);
            }
            if (new RegExp(`Open\\((["'])${name}\\1\\)`, "i").test(source)) {
                score += 5;
                specificSignalCount += 1;
                reasons.push(`open_call:${name}`);
                matchedSymbols.push(name);
            }
        }
        const tokenHits = [];
        for (const token of signals.queryTokens) {
            if (token.length < 3) {
                continue;
            }
            const tokenRe = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
            if (tokenRe.test(source)) {
                tokenHits.push(token);
            }
        }
        if (tokenHits.length > 0) {
            score += Math.min(3, tokenHits.length);
            specificSignalCount += Math.min(2, tokenHits.length);
            matchedSymbols.push(...tokenHits);
        }
        for (const signal of ["MouseButton1Click", "Activated", "FocusLost"]) {
            if (source.includes(signal)) {
                score += 1;
                matchedSignals.push(signal);
            }
        }
        if (specificSignalCount > 0 && /(PlayerGui|StarterGui|ScreenGui)/.test(source)) {
            score += 1;
            reasons.push("gui_scope_reference");
        }
        if (specificSignalCount > 0 && this.scriptLooksLikeUiController(script, source)) {
            score += 2;
            reasons.push("ui_controller_prior");
        }
        const entrypoint = this.index.findEntrypoints({ query: script.name, limit: 10 }).find((item) => pathKey(item.path) === pathKey(script.path));
        if (specificSignalCount > 0 && (entrypoint?.category === "ui_controller" || entrypoint?.category === "client_bootstrap")) {
            score += 3;
            reasons.push(`entrypoint:${entrypoint.category}`);
        }
        if (specificSignalCount > 0 && /\/ui\/|\/screens?\//i.test(script.path.join("/"))) {
            score += 2;
            reasons.push("ui_path_prior");
        }
        if (this.isGenericUiUtilityPath(script.path) && !matchedSignals.length && sharedTokens.length === 0) {
            score -= 4;
            reasons.push("generic_utility_penalty");
        }
        if (this.isExternalUiPackagePath(script.path)) {
            score -= 6;
            reasons.push("package_penalty");
        }
        if (specificSignalCount === 0 && tokenHits.length < 2) {
            score = 0;
        }
        return {
            score,
            reasons: this.trimStrings(reasons, 5),
            matchedSignals: this.trimStrings(matchedSignals, 5),
            matchedSymbols: this.trimStrings(matchedSymbols, 6)
        };
    }
    async findUiBindings(targetInput, limitInput = 20) {
        await this.ensureIndexWarm();
        await this.ensureUiIndexWarm();
        const target = targetInput && typeof targetInput === "object" ? targetInput : {};
        const hasUiPath = Array.isArray(target.uiPath);
        const hasScriptPath = Array.isArray(target.scriptPath);
        const hasQuery = typeof target.query === "string" && target.query.trim().length > 0;
        if (Number(hasUiPath) + Number(hasScriptPath) + Number(hasQuery) !== 1) {
            throw new BridgeError("invalid_target", "Exactly one of uiPath, scriptPath, or query is required", 400);
        }
        const limit = Math.max(1, Math.min(Math.trunc(limitInput ?? 20), 100));
        const bindings = [];
        if (hasUiPath) {
            const uiPath = normalizePath(target.uiPath);
            const uiTree = await this.cache.getUiTree(uiPath);
            if (!uiTree) {
                throw new BridgeError("not_found", `UI path not found: ${uiPath.join("/")}`, 404);
            }
            const signals = this.collectUiTargetSignals(uiTree);
            const queries = [...new Set([...signals.uiNames, ...signals.queryTokens])];
            const candidates = new Map();
            for (const query of queries) {
                for (const hit of this.index.searchText(query, { limit: 25 })) {
                    candidates.set(pathKey(hit.path), hit.path);
                }
            }
            for (const path of candidates.values()) {
                const script = await this.cache.getScript(path);
                if (!script) {
                    continue;
                }
                const { score, reasons, matchedSignals, matchedSymbols } = this.scoreUiBindingCandidate(uiTree, script);
                if (score < 4) {
                    continue;
                }
                bindings.push({
                    uiPath,
                    scriptPath: script.path,
                    confidence: Math.max(0.2, Math.min(0.95, 0.25 + score / 16)),
                    reasons,
                    matchedSignals,
                    matchedSymbols
                });
            }
        }
        else if (hasScriptPath) {
            const scriptPath = normalizePath(target.scriptPath);
            const script = await this.cache.getScript(scriptPath);
            if (!script) {
                throw new BridgeError("not_found", `Script not found: ${scriptPath.join("/")}`, 404);
            }
            const names = [...new Set([...script.source.matchAll(/WaitForChild\((["'])([^"']+)\1\)/g)].map((match) => match[2]).slice(0, 12))];
            for (const name of names) {
                for (const hit of this.uiIndex.search(name, { limit: 8 })) {
                    bindings.push({
                        uiPath: hit.path,
                        scriptPath,
                        confidence: Math.max(0.2, Math.min(0.9, hit.score / 10)),
                        reasons: [`ui_name_match:${name}`],
                        matchedSignals: ["WaitForChild"],
                        matchedSymbols: [name]
                    });
                }
            }
        }
        else {
            const query = target.query.trim();
            const uiHits = this.uiIndex.search(query, { limit: Math.min(limit, 10) });
            const textHits = this.index.searchText(query, { limit: Math.min(limit * 2, 30) });
            for (const uiHit of uiHits) {
                for (const scriptHit of textHits.slice(0, 8)) {
                    bindings.push({
                        uiPath: uiHit.path,
                        scriptPath: scriptHit.path,
                        confidence: Math.max(0.2, Math.min(0.8, (uiHit.score + scriptHit.score) / 20)),
                        reasons: [`ui_match:${uiHit.matchedProps.join(",") || "path"}`, `script_match:${scriptHit.score}`],
                        matchedSignals: [],
                        matchedSymbols: [query]
                    });
                }
            }
        }
        bindings.sort((a, b) => b.confidence - a.confidence || (a.scriptPath?.join("/") ?? "").localeCompare(b.scriptPath?.join("/") ?? "") || (a.uiPath?.join("/") ?? "").localeCompare(b.uiPath?.join("/") ?? ""));
        return {
            bindings: bindings.slice(0, limit)
        };
    }
    requireSession(sessionId) {
        const session = this.sessions.resolve(sessionId);
        if (!session) {
            throw new BridgeError("invalid_session", "Unknown or inactive session", 409);
        }
        return session;
    }
    assertMutatingPlace(placeId) {
        if (!placeId) {
            return;
        }
        const active = this.liveSession();
        const knownPlaceId = active?.placeId ?? this.cache.metadata()?.placeId ?? null;
        if (!knownPlaceId) {
            throw new BridgeError("studio_offline", "Studio is offline", 503);
        }
        if (placeId !== knownPlaceId) {
            throw new BridgeError("project_mismatch", `placeId mismatch: expected ${knownPlaceId}, got ${placeId}`, 409, {
                expectedPlaceId: knownPlaceId,
                actualPlaceId: placeId
            });
        }
    }
    assertUiMutationsAllowed(placeId) {
        this.assertMutatingPlace(placeId);
        const playState = this.liveSession()?.playState ?? "stopped";
        if (playState !== "stopped" && playState !== "error") {
            throw new BridgeError("play_mutation_forbidden", "UI mutations are forbidden during playtest", 409, {
                playState
            });
        }
    }
    projectSummaryRecommendedCalls(scope) {
        if (scope === "scripts") {
            return ["rbx_get_related_context", "rbx_search_text", "rbx_find_symbols"];
        }
        if (scope === "ui") {
            return ["rbx_get_ui_summary", "rbx_search_ui", "rbx_get_ui_tree"];
        }
        return ["rbx_get_related_context", "rbx_get_ui_summary", "rbx_search_text"];
    }
    normalizeRelatedContextTarget(target) {
        const hasPath = Array.isArray(target?.path);
        const hasSymbol = typeof target?.symbol === "string" && target.symbol.trim().length > 0;
        const hasQuery = typeof target?.query === "string" && target.query.trim().length > 0;
        const setCount = Number(hasPath) + Number(hasSymbol) + Number(hasQuery);
        if (setCount !== 1) {
            throw new BridgeError("invalid_target", "Exactly one of target.path, target.symbol or target.query is required", 400);
        }
        if (hasPath) {
            return { kind: "path", path: normalizePath(target.path) };
        }
        if (hasSymbol) {
            return { kind: "symbol", symbol: target.symbol.trim() };
        }
        return { kind: "query", query: target.query.trim() };
    }
    mergePathReasons(items, limit) {
        const merged = new Map();
        for (const item of items) {
            const key = pathKey(item.path);
            if (!merged.has(key)) {
                merged.set(key, { path: item.path, reasons: [] });
            }
            merged.get(key).reasons.push(item.reason);
        }
        return [...merged.values()]
            .map((entry) => ({
            path: entry.path,
            reason: compactText(entry.reasons.join("; "), 140)
        }))
            .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")))
            .slice(0, limit);
    }
    async inferUiBindingHints(summary, verbosity = "normal") {
        if (this.cache.scriptCount() === 0) {
            return [];
        }
        const result = await this.findUiBindings({ uiPath: summary.path }, verbosity === "minimal" ? 3 : 5);
        return result.bindings.slice(0, verbosity === "minimal" ? 3 : 5).map((binding) => ({
            path: binding.scriptPath,
            reason: `heuristic:${binding.reasons[0] ?? "binding_candidate"}`
        }));
    }
    normalizeTemplateOptions(kind, optionsInput) {
        const options = optionsInput && typeof optionsInput === "object" ? { ...optionsInput } : null;
        if (!options) {
            throw new BridgeError("template_invalid", "options must be an object", 400);
        }
        const allowedKeys = kind === "modal"
            ? new Set(["name", "title", "bodyText", "confirmText", "cancelText", "size", "showCloseButton"])
            : new Set(["name", "title", "columns", "cardAspectRatio", "showPurchaseButton", "sampleItems"]);
        for (const key of Object.keys(options)) {
            if (!allowedKeys.has(key)) {
                throw new BridgeError("template_invalid", `Unknown template option: ${key}`, 400, { kind, key });
            }
        }
        if (typeof options.name !== "string" || !options.name.trim()) {
            throw new BridgeError("template_invalid", "options.name is required", 400);
        }
        if (typeof options.title !== "string" || !options.title.trim()) {
            throw new BridgeError("template_invalid", "options.title is required", 400);
        }
        if (kind === "shop_grid" && options.sampleItems !== undefined) {
            if (!Array.isArray(options.sampleItems)) {
                throw new BridgeError("template_invalid", "sampleItems must be an array", 400);
            }
            for (const [index, item] of options.sampleItems.entries()) {
                if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) {
                    throw new BridgeError("template_invalid", "Each sample item must have a non-empty name", 400, { itemIndex: index + 1 });
                }
            }
        }
        return options;
    }
    normalizeReadMaxAgeMs(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return this.options.defaultReadMaxAgeMs;
        }
        return Math.max(0, Math.trunc(value));
    }
    ageMsFromUpdatedAt(updatedAt) {
        const parsed = Date.parse(updatedAt);
        if (!Number.isFinite(parsed)) {
            return 0;
        }
        return Math.max(0, nowMs() - parsed);
    }
}
