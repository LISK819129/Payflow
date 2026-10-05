import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The demo agent's bearer credential lives in `.env.agent.local` (git-ignored
 * by `.env*`), written by the evidence step that registers the agent in the UI.
 * It is never printed. It is an agent credential: it grants no PayPal access.
 * The deployed site's agent has its own file (`.env.agent.deploy.local`, written
 * by pnpm deploy:setup); AGENT_TOKEN_FILE picks which one the demo agents use.
 */
const DEFAULT_FILE = ".env.agent.local";

export function readAgentToken(file = process.env.AGENT_TOKEN_FILE || DEFAULT_FILE): string {
  const FILE = file;
  if (!existsSync(FILE)) throw new Error(`${FILE} not found: register the agent first (pnpm evidence register-agent …)`);
  const m = /^AGENT_TOKEN=(pfa_[0-9a-f]{12}_[A-Za-z0-9_-]{43})$/m.exec(readFileSync(FILE, "utf8"));
  if (!m) throw new Error(`${FILE} has no AGENT_TOKEN`);
  return m[1];
}

export function writeAgentToken(token: string, file = DEFAULT_FILE) {
  writeFileSync(file, `# Demo agent credential (Phase 9). Never commit. Revoking the agent in PayFlow makes it useless.\nAGENT_TOKEN=${token}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Removes any trace of the credential from text before it is printed or saved. */
export function redact(text: string, token: string) {
  return text.split(token).join("pfa_…REDACTED").split(token.slice(17)).join("…REDACTED");
}
