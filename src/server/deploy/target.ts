import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";

/**
 * Where the deploy commands point. Read from `.env.deploy.local` (git-ignored,
 * created on first run): the deployed URL and the Render database's *External*
 * connection string. It is applied before any PayFlow module reads its
 * configuration, so the commands talk to the hosted database — never the local one.
 */
export const DEPLOY_FILE = ".env.deploy.local";
/** The deployed demo agent's credential — kept apart from the local one in .env.agent.local. */
export const DEPLOY_AGENT_FILE = ".env.agent.deploy.local";

const TEMPLATE = `# PayFlow deployment target. Git-ignored — never commit this file.
# 1. Render Dashboard → payflow-web → copy the URL at the top (https://….onrender.com)
DEPLOY_URL=
# 2. Render Dashboard → payflow-db → Connect → "External Database URL" (starts with postgresql://)
DEPLOY_DATABASE_URL=
`;

export type Target = { url: string; databaseUrl: string; local: boolean };

export function readTarget(opts: { allowLocal?: boolean; file?: string } = {}): Target | { error: string; created?: boolean } {
  const file = opts.file ?? DEPLOY_FILE;
  if (!existsSync(file)) {
    writeFileSync(file, TEMPLATE, { encoding: "utf8", mode: 0o600 });
    return { error: `Created ${file}. Fill in DEPLOY_URL and DEPLOY_DATABASE_URL (instructions inside), then run the command again.`, created: true };
  }
  const v = parse(readFileSync(file, "utf8"));
  return validateTarget(v.DEPLOY_URL ?? "", v.DEPLOY_DATABASE_URL ?? "", opts.allowLocal ?? false);
}

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

export function validateTarget(rawUrl: string, rawDb: string, allowLocal: boolean): Target | { error: string } {
  const url = rawUrl.trim().replace(/\/+$/, "");
  const databaseUrl = rawDb.trim();
  if (!url) return { error: "DEPLOY_URL is empty" };
  if (!databaseUrl) return { error: "DEPLOY_DATABASE_URL is empty" };
  let u: URL;
  let d: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "DEPLOY_URL is not a URL" };
  }
  try {
    d = new URL(databaseUrl);
  } catch {
    return { error: "DEPLOY_DATABASE_URL is not a URL (copy Render's External Database URL)" };
  }
  if (!/^postgres(ql)?:$/.test(d.protocol)) return { error: "DEPLOY_DATABASE_URL must start with postgresql://" };
  const local = LOCAL.has(u.hostname) || LOCAL.has(d.hostname);
  if (local && !allowLocal) return { error: "DEPLOY_URL / DEPLOY_DATABASE_URL point at this computer. Use the Render values (or --allow-local for a local rehearsal)." };
  if (!local && u.protocol !== "https:") return { error: "DEPLOY_URL must be https://" };
  if (!local && /^dpg-[a-z0-9]+-a$/.test(d.hostname)) return { error: "That is Render's *Internal* Database URL; copy the External one (its host ends in .render.com)" };
  // Render's external connections require TLS.
  if (!LOCAL.has(d.hostname) && !d.searchParams.has("sslmode")) d.searchParams.set("sslmode", "require");
  return { url, databaseUrl: d.toString(), local };
}

/** Points this process at the target before PayFlow's config is first read. */
export function applyTarget(t: Target) {
  process.env.DATABASE_URL = t.databaseUrl;
}
