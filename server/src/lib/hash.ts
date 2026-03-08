import { createHash } from "node:crypto";

export function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function sourceHash(text: string): string {
  const normalized = normalizeSource(text);
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(normalized, "utf8");
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function digestForFileKey(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
