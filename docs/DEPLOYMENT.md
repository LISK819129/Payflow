# Deploying PayFlow (Render)

PayFlow runs as three pieces: a **web service** (Next.js app, API, MCP server, PayPal webhook receiver), a **background worker** (pg-boss jobs: workflow steps, PayPal event routing, timers, observations) and **PostgreSQL**. PayPal stays in **Sandbox**; PayFlow refuses to boot with `PAYPAL_ENV=live`.

`render.yaml` is a Blueprint for exactly this. It contains no secrets.

## Services

| Service | Render type | Build | Start |
|---|---|---|---|
| `payflow-web` | Web Service, Node, **1 instance** | `corepack enable && pnpm install --frozen-lockfile && pnpm build` | `pnpm start` |
| `payflow-worker` | Background Worker, Node | `corepack enable && pnpm install --frozen-lockfile` | `pnpm worker` |
| `payflow-db` | PostgreSQL 17 | — | — |

- **Node** 24 (`NODE_VERSION=24`; `engines.node >= 20.9`). **pnpm** 11.15.1 via `packageManager` + corepack.
- **Migrations**: `pnpm db:migrate` as the web service's pre-deploy command. It refuses a non-UTF8 database, applies the Drizzle migrations and creates the pg-boss queues. Run it before the worker starts on a new database.
- **Health**: `GET /api/health` (liveness: the process answers) and `GET /api/health/ready` (readiness: database reachable, migrations current; also reports which integrations are configured and whether a worker heartbeat is recent — states only, never values). Render's health check uses `/api/health/ready`.
- **One web instance.** Rate limits (login, MCP, AI drafting, Test Runs) are in-process. That is safe with exactly one instance, which is what the judging deployment runs. Scaling out would need them moved to Postgres first. The money guards (AI budget caps, authority, budgets, idempotency) are in Postgres already.

## Environment

Set in the Render dashboard (`sync: false` in the Blueprint). Web and worker need the same values unless noted.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | From the Render database. **A new credential** — never the local-development password in `.env.example`; PayFlow refuses to boot in production if it is reused, if the host is local, or if the password is shorter than 16 characters. |
| `APP_URL` | `https://<service>.onrender.com` (must be https in production). |
| `SESSION_SECRET` | 32+ random characters; Render can generate it. Identical on web and worker. |
| `PAYPAL_ENV` | `sandbox` (the only accepted value). |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The Sandbox app's credentials. Set together. |
| `PAYPAL_WEBHOOK_ID` | Printed by `pnpm paypal:webhook:register https://<render-host>` (below). |
| `PAYPAL_ALLOW_SIMULATOR_EVENTS` | `false` (refused in production otherwise). |
| `AI_PROVIDER`, `OPENAI_API_KEY` | `openai` and the key. Never exposed to agents or the browser. |
| `AI_BUDGET_USD` | Lifetime hard cap across every model call (default 5). |
| `AI_DAILY_CAP_USD` | Rolling 24-hour cap. **Required** when `PAYFLOW_DEMO_MODE=true` and AI is on. |
| `AI_COMPILES_PER_USER_PER_HOUR`, `AI_COMPILES_PER_WORKSPACE_PER_DAY`, `TEST_RUNS_PER_USER_PER_HOUR` | Per-person limits on what costs money (defaults 12 / 60 / 60). |
| `PAYFLOW_DEMO_MODE` | `true` on the judging deployment: enables the owner's "Restore demo setup". |
| `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` | The judge login created by `pnpm db:seed`. Choose a new password; share it with judges privately. |
| `DEMO_SUPPLIER_ACME_EMAIL`, `DEMO_SUPPLIER_AWS_EMAIL` | Sandbox personal accounts used as the demo suppliers (below). |
| `TRUSTED_PROXY_HOPS` | Default 1 (Render's proxy). Used to read the caller's IP from `X-Forwarded-For` safely. |
| `NODE_ENV` | `production` (Next sets it for `next start`; set it on the worker). |
| `PAYFLOW_WORKER_WATCH` | `0` on the worker: a deployed worker never reloads code under itself. |

Never set `PAYFLOW_ALLOW_LOCAL_DB` on a host — it exists only for a local production rehearsal.

## First deploy (Phase 11)

1. Create the Blueprint from `render.yaml`; fill the `sync: false` values (APP_URL can be filled after the URL exists).
2. Deploy. The pre-deploy step migrates the empty database.
3. In the web service shell: `pnpm db:seed` (judge owner) then `pnpm demo:restore` (demo workflows, authorities and the Cloud Procurement Agent). The agent's credential is written to `.env.agent.local` on that instance — copy it to wherever the demo agent runs, then delete the file.
4. Move the PayPal webhook (next section), put the printed id in `PAYPAL_WEBHOOK_ID`, redeploy.
5. Check `https://<host>/api/health/ready` → `"status":"ready"` with `"worker":"recent"`.

## Moving the PayPal webhook

The Sandbox app has one PayFlow webhook (currently pointing at a stopped development tunnel). From any machine with the Sandbox credentials:

```
pnpm paypal:webhook:register https://<render-host>
```

It **moves** the existing webhook (`PATCH`), removes other PayFlow webhooks pointing at dead tunnels, and only creates one if none exists — never a duplicate. Webhooks for other apps are not touched. It prints `PAYPAL_WEBHOOK_ID`. Incoming events stay signature-verified, stored once per PayPal event id, confirmed with PayPal's API before they confirm anything, and processed asynchronously by the worker.

## Demo Sandbox recipients

Phase 9's payouts ended `UNCLAIMED` because the recipient addresses were not PayPal accounts. For the final demo, create two **Sandbox personal accounts** (developer.paypal.com → Testing tools → Sandbox accounts → Create account → Personal, US), e.g. "Acme Cloud" and "AWS", and set their generated emails in `DEMO_SUPPLIER_ACME_EMAIL` / `DEMO_SUPPLIER_AWS_EMAIL`, then run `pnpm demo:restore` — it updates the demo authority's allow-list as a new, audited version. A payout to a real Sandbox account is reported by PayPal as `SUCCESS` for the item, which PayFlow shows as **Settled**. Creating Sandbox accounts needs a person logged in to the PayPal developer dashboard; PayFlow does not do it.

## Local production rehearsal

```
# a fresh UTF8 database on the embedded Postgres, then:
# .env.production.local (git-ignored): DATABASE_URL=<judge db>, PAYFLOW_ALLOW_LOCAL_DB=true, APP_URL=http://localhost:3000, PAYFLOW_DEMO_MODE=true, AI_DAILY_CAP_USD=...
pnpm db:migrate && pnpm db:seed && pnpm demo:restore   # with DATABASE_URL pointing at the judge db
pnpm build && pnpm start
NODE_ENV=production PAYFLOW_WORKER_WATCH=0 pnpm worker
```
