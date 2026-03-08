export function normalizePath(path: unknown): string[] {
  if (!Array.isArray(path)) {
    throw new Error("path must be an array");
  }
  const out = path
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
  if (out.length < 2) {
    throw new Error("path must include service and script name");
  }
  return out;
}

export function pathKey(path: string[]): string {
  return path.join("\u0000");
}

export function serviceFromPath(path: string[]): string {
  return path[0];
}

export function scriptNameFromPath(path: string[]): string {
  return path[path.length - 1];
}
