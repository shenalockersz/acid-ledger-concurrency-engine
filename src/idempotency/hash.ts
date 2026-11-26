import { createHash } from "node:crypto";

/**
 * Recursively normalize values (sorted object keys, stringified bigints, ISO dates)
 * so semantically identical JSON payloads produce identical SHA-256 digests.
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        sorted[key] = canonicalize(val);
      }
    }
    return sorted;
  }
  return value;
}

export function hashRequestPayload(payload: unknown): string {
  const serialized = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(serialized).digest("hex");
}
