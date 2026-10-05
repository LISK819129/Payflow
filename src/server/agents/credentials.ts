import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Agent bearer credentials: `pfa_<credentialId>_<secret>`.
 *
 * The credential id (12 hex chars) is a public lookup handle; the secret is
 * 32 random bytes (base64url). Only SHA-256(secret) is stored — the secret is
 * high-entropy, so a fast hash is the right tool (a password KDF adds nothing),
 * and a database leak yields no usable token. The raw token exists once: in
 * the response that created or rotated it.
 */
const TOKEN = /^pfa_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export type IssuedCredential = { credentialId: string; credentialHash: string; token: string };

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function issueCredential(): IssuedCredential {
  const credentialId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { credentialId, credentialHash: hashSecret(secret), token: `pfa_${credentialId}_${secret}` };
}

/** Parses an Authorization header value. Anything not exactly one well-formed token is rejected. */
export function parseBearer(header: string | null | undefined): { credentialId: string; secret: string } | null {
  if (!header || header.length > 200) return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m) return null;
  const t = TOKEN.exec(m[1]);
  return t ? { credentialId: t[1], secret: t[2] } : null;
}

/** Constant-time comparison of a presented secret with the stored hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** For logs and the UI: the public part only. */
export const credentialHint = (credentialId: string) => `pfa_${credentialId}_…`;
