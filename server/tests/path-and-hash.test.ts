import { describe, expect, it } from "vitest";
import { normalizeSource, sourceHash } from "../src/lib/hash.js";
import { normalizePath, pathKey } from "../src/lib/path.js";

function fnv1aUtf8(text: string): string {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(text, "utf8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("path helpers", () => {
  it("normalizes and validates path", () => {
    const normalized = normalizePath([" ServerScriptService ", "Main"]);
    expect(normalized).toEqual(["ServerScriptService", "Main"]);
  });

  it("throws on invalid path", () => {
    expect(() => normalizePath(["OnlyService"])).toThrow(/service and script name/);
    expect(() => normalizePath("not-array")).toThrow(/array/);
  });

  it("builds stable key", () => {
    const a = pathKey(["ServerScriptService", "Main", "Init"]);
    const b = pathKey(["ServerScriptService", "Main", "Init"]);
    expect(a).toBe(b);
  });
});

describe("hash helpers", () => {
  it("normalizes line endings", () => {
    expect(normalizeSource("a\r\nb")).toBe("a\nb");
  });

  it("returns same hash for equivalent line endings", () => {
    const a = sourceHash("print('x')\r\nprint('y')");
    const b = sourceHash("print('x')\nprint('y')");
    expect(a).toBe(b);
  });

  it("returns stable hash for cyrillic text using utf8 bytes", () => {
    const text = "print('привет мир')";
    expect(sourceHash(text)).toBe(fnv1aUtf8(text));
  });

  it("changes hash when cyrillic text changes", () => {
    const a = sourceHash("print('привет')");
    const b = sourceHash("print('привеТ')");
    expect(a).not.toBe(b);
  });
});
