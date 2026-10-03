/**
 * Creates .env.local with freshly generated local secrets if it does not exist.
 * Never overwrites an existing file. Integration keys are left blank for the
 * developer to fill in; the app reports them as "setup required" until then.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const target = ".env.local";
if (existsSync(target)) {
  console.log(`${target} already exists; not touching it.`);
  process.exit(0);
}

const template = readFileSync(".env.example", "utf8");
const filled = template
  .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString("base64url")}`)
  .replace(/^SEED_OWNER_PASSWORD=.*$/m, `SEED_OWNER_PASSWORD=${randomBytes(12).toString("base64url")}`);
writeFileSync(target, filled, { flag: "wx" });
console.log(`Wrote ${target}. The owner login is SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD in that file.`);
