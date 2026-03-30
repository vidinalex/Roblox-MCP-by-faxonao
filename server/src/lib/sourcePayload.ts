import { BridgeError } from "./errors.js";

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeUtf8Base64(input: unknown, fieldName = "sourceBase64"): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new BridgeError("invalid_source_base64", `${fieldName} must be a non-empty base64 string`, 400, {
      badField: fieldName
    });
  }
  const normalized = input.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_RE.test(normalized)) {
    throw new BridgeError("invalid_source_base64", `${fieldName} is not valid base64`, 400, {
      badField: fieldName
    });
  }
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== normalized) {
    throw new BridgeError("invalid_source_base64", `${fieldName} is not valid UTF-8 base64`, 400, {
      badField: fieldName
    });
  }
  return decoded;
}

export function resolveSourcePayload(
  source: unknown,
  sourceBase64: unknown,
  sourceFieldName = "source",
  sourceBase64FieldName = "sourceBase64"
): string {
  if (typeof sourceBase64 === "string" && sourceBase64.length > 0) {
    return decodeUtf8Base64(sourceBase64, sourceBase64FieldName);
  }
  return typeof source === "string" ? source : "";
}
