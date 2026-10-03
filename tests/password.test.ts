import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password!!")).not.toEqual(await hashPassword("same password!!"));
  });

  it("rejects malformed stored values instead of throwing", async () => {
    expect(await verifyPassword("anything", "md5$abc")).toBe(false);
  });

  it("refuses short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
});
