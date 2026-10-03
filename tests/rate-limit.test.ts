import { describe, expect, it } from "vitest";
import { clearHits, isLimited, rateLimit, recordHit } from "@/server/security/rate-limit";

describe("rate limiting", () => {
  it("locks a key only after the limit of recorded failures, and clears on success", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 7; i++) recordHit(k, 60_000);
    expect(isLimited(k, 8)).toBe(false);
    recordHit(k, 60_000);
    expect(isLimited(k, 8)).toBe(true);
    clearHits(k);
    expect(isLimited(k, 8)).toBe(false);
  });

  it("checking a key never counts as a hit", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 50; i++) expect(isLimited(k, 1)).toBe(false);
  });

  it("rateLimit counts every call (used for webhook flood control)", () => {
    const k = `t:${Math.random()}`;
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    expect(rateLimit(k, 2, 60_000).ok).toBe(false);
  });
});
