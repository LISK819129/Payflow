import { createHash } from "node:crypto";

export { canonicalJson } from "./canonical-json";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
