/**
 * The caller's IP for rate limiting. Behind a proxy (Render), the client can
 * put anything at the *start* of X-Forwarded-For; each trusted proxy appends
 * the address it saw. So take the entry TRUSTED_PROXY_HOPS from the end
 * (default 1: one proxy in front of PayFlow). Never use the first entry.
 */
export function clientIp(get: (name: string) => string | null, hops = Number(process.env.TRUSTED_PROXY_HOPS ?? "1")): string {
  const xff = get("x-forwarded-for");
  if (!xff) return "local";
  const parts = xff
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "local";
  const n = Number.isInteger(hops) && hops > 0 ? hops : 1;
  return parts[Math.max(0, parts.length - n)];
}
