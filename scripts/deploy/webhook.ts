/**
 * pnpm deploy:webhook https://<your-app>.onrender.com  [--dry-run]
 *
 * Points PayFlow's EXISTING PayPal Sandbox webhook at the deployed app. It
 * moves the webhook (same id), removes stale PayFlow webhooks left by old
 * development tunnels, and never creates a duplicate. --dry-run only reads
 * PayPal and prints what would happen.
 *
 * Uses the PixelForge Sandbox app credentials from .env.local (the same app
 * the deployment uses). Refuses to move anything until the site reports ready.
 */
import "../load-env";
import { randomBytes } from "node:crypto";
import { JUDGE_DEPLOYMENT } from "../../src/server/deploy/config";
import { paypal } from "../../src/server/paypal/client";
import { PayPalApiError } from "../../src/server/paypal/errors";
import { planWebhook, registerWebhook } from "../../src/server/paypal/webhook-registration";

async function main() {
  const host = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
  const dry = process.argv.includes("--dry-run");
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (the PixelForge Sandbox app) must be in .env.local on this computer.\nNo .env.local yet? Run pnpm env:init, then add the two values in a text editor.");
    process.exit(2);
  }
  // This command talks only to PayPal; config validation still wants these (a fresh clone has no .env.local).
  process.env.SESSION_SECRET ||= randomBytes(32).toString("base64url");
  process.env.DATABASE_URL ||= "postgresql://unused@127.0.0.1/unused";
  if (!/^https:\/\/[^/]+$/.test(host)) {
    console.error("Usage: pnpm deploy:webhook https://<your-app>.onrender.com [--dry-run]");
    process.exit(2);
  }

  if (!dry) {
    const res = await fetch(`${host}/api/health/ready`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { status?: string; checks?: { paypalWebhook?: string } } | null) : null;
    if (!res || res.status !== 200 || body?.status !== "ready") {
      console.error(`${host}/api/health/ready is not ready (${res?.status ?? "unreachable"}). Deploy and run pnpm deploy:setup first — PayPal would otherwise deliver to a site that cannot verify events.`);
      process.exit(1);
    }
    if (body.checks?.paypalWebhook !== "configured") console.warn("Warning: the site reports PAYPAL_WEBHOOK_ID is missing; it is set in render.yaml — check payflow-web's Environment.");
  }

  const plan = await planWebhook(paypal(), host);
  console.log(`Target:   ${plan.url}`);
  console.log(`Existing: ${plan.existing ? `${plan.existing.id} → ${plan.existing.url}` : "none"}`);
  console.log(`Action:   ${plan.action === "move" ? "MOVE the existing webhook (same id)" : plan.action === "already_here" ? "nothing to move — it already points here" : "CREATE the first webhook"}`);
  for (const s of plan.remove) console.log(`Remove:   ${s.id} → ${s.url} (stale PayFlow webhook)`);
  if (plan.existing && plan.existing.id !== JUDGE_DEPLOYMENT.webhookId) console.log(`Note:     the existing id differs from render.yaml's PAYPAL_WEBHOOK_ID (${JUDGE_DEPLOYMENT.webhookId}).`);
  if (dry) {
    console.log("\n--dry-run: nothing changed.");
    return;
  }

  const r = await registerWebhook(paypal(), host);
  const after = await planWebhook(paypal(), host);
  console.log(`\nDone: ${r.action} webhook ${r.id} → ${r.url}${r.removed.length ? `; removed ${r.removed.join(", ")}` : ""}`);
  if (after.action !== "already_here") {
    console.error("PayPal does not report the webhook at the new URL yet — run the command again.");
    process.exit(1);
  }
  if (r.id !== JUDGE_DEPLOYMENT.webhookId) {
    console.log(`\nIMPORTANT: the webhook id is ${r.id}, not ${JUDGE_DEPLOYMENT.webhookId}. In Render, set PAYPAL_WEBHOOK_ID=${r.id} on payflow-web AND payflow-worker, then Manual Deploy both.`);
  } else {
    console.log(`PAYPAL_WEBHOOK_ID is ${r.id} — already set in render.yaml; nothing to change in Render.`);
  }
  console.log("\nNext: pnpm deploy:verify --webhook-test   (creates one harmless Sandbox catalog product to prove delivery; no money)");
}

main().catch((err) => {
  if (err instanceof PayPalApiError) console.error(`PayPal error ${err.code}: ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`);
  else console.error((err as Error).message);
  process.exit(1);
});
