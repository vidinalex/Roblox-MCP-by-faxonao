export const PUBLIC_PATH_GOTCHA = "Use slash-delimited paths like Service/Folder/Script.";

const PATH_KEY_NAMES = new Set([
  "path",
  "parentPath",
  "newParentPath",
  "rootPath",
  "sourcePath",
  "targetPath",
  "uiPath",
  "scriptPath",
  "resolvedPath",
  "clonedPath",
  "deletedPath"
]);

const PATH_ARRAY_KEY_NAMES = new Set(["paths", "entryPaths"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePublicPath(pathInput: unknown, fieldName = "path"): string[] {
  if (typeof pathInput !== "string") {
    throw new Error(`${fieldName} must be a slash-delimited string`);
  }
  const value = pathInput.trim().replace(/^\/+|\/+$/g, "");
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty slash-delimited string`);
  }
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`${fieldName} must include at least a service and child name`);
  }
  return segments;
}

export function parsePublicPathPrefix(pathInput: unknown, fieldName = "pathPrefix"): string[] {
  if (typeof pathInput !== "string") {
    throw new Error(`${fieldName} must be a slash-delimited string`);
  }
  const value = pathInput.trim().replace(/^\/+|\/+$/g, "");
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty slash-delimited string`);
  }
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 1) {
    throw new Error(`${fieldName} must include at least one path segment`);
  }
  return segments;
}

export function formatPublicPath(path: string[]): string {
  return path.join("/");
}

export function normalizePathField(value: unknown, fieldName: string): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (PATH_KEY_NAMES.has(fieldName)) {
    return parsePublicPath(value, fieldName);
  }
  if (fieldName === "pathPrefix") {
    return parsePublicPathPrefix(value, fieldName);
  }
  if (PATH_ARRAY_KEY_NAMES.has(fieldName)) {
    if (!Array.isArray(value)) {
      throw new Error(`${fieldName} must be an array of slash-delimited strings`);
    }
    const minSegments = fieldName === "entryPaths" ? 2 : 2;
    return value.map((item, index) => {
      const parsed = parsePublicPath(item, `${fieldName}[${index}]`);
      if (parsed.length < minSegments) {
        throw new Error(`${fieldName}[${index}] must include at least ${minSegments} segments`);
      }
      return parsed;
    });
  }
  return value;
}

export function normalizePublicPayload(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => normalizePublicPayload(item));
  }
  if (!isPlainObject(input)) {
    return input;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isPlainObject(value)) {
      out[key] = normalizePublicPayload(value);
      continue;
    }
    if (Array.isArray(value) && !PATH_ARRAY_KEY_NAMES.has(key)) {
      out[key] = value.map((item) => normalizePublicPayload(item));
      continue;
    }
    out[key] = normalizePathField(value, key);
  }
  return out;
}

function looksLikePathSegmentArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

function looksLikePathMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((item) => looksLikePathSegmentArray(item));
}

export function serializePublicPayload(input: unknown, keyHint?: string): unknown {
  if (looksLikePathSegmentArray(input)) {
    if (keyHint === "resolvedPathSegments") {
      return [...input];
    }
    if (keyHint && (PATH_KEY_NAMES.has(keyHint) || keyHint === "pathPrefix")) {
      return formatPublicPath(input);
    }
    return [...input];
  }
  if (looksLikePathMatrix(input)) {
    if (keyHint && PATH_ARRAY_KEY_NAMES.has(keyHint)) {
      return input.map((item) => formatPublicPath(item));
    }
    return input.map((item) => [...item]);
  }
  if (Array.isArray(input)) {
    return input.map((item) => serializePublicPayload(item));
  }
  if (!isPlainObject(input)) {
    return input;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "resolvedPathSegments" && looksLikePathSegmentArray(value)) {
      out[key] = [...value];
      continue;
    }
    out[key] = serializePublicPayload(value, key);
  }
  return out;
}

export function summarizeErrorShape(fieldName: string, expectedType: string, receivedType: string, exampleValue: unknown) {
  return {
    badField: fieldName,
    expectedType,
    receivedType,
    coercionHint: PUBLIC_PATH_GOTCHA,
    correctedPayloadExample: exampleValue
  };
}
