import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, undefined dropped. Postgres jsonb does
 * not preserve key order, so hashing must not depend on it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = normalize(v);
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
