# DEPLOY PAYFLOW FROM ZERO

This page is everything needed to put PayFlow online for judging on Render, check it works, hand it to judges, and delete it afterwards. It assumes nothing except this repository, a Render account and the PixelForge PayPal Sandbox app. Work through it top to bottom; every step says what you should see.

**Time:** about 30 minutes, most of it waiting for Render's first build.
**Cost:** about **$20.30/month**, charged per second only while the three resources exist. Create them close to judging and delete them right after.

---

## Checklist

```
[ ] Add Render payment method
[ ] Confirm hackathon credit
[ ] Create Blueprint from LISK819129/Payflow
[ ] Enter secrets
[ ] Apply
[ ] Wait for 3 resources
[ ] Run setup
[ ] Configure PayPal webhook
[ ] Run verification
[ ] Login as judge
[ ] Run judge Test Run scenarios
```

Each item is a section below (§2–§12).

---

## 0. What gets created (and nothing else)

| Resource | Kind | Plan (Render plan ID) | ≈ per month |
|---|---|---|---|
| `payflow-db` | PostgreSQL 18, 1 GB disk | Basic-256mb (`0.1c-256mb`) | $6.30 |
| `payflow-web` | Web service, **exactly 1 instance** | Starter (`0.5c-512mb`) | $7.00 |
| `payflow-worker` | Background worker | Starter (`0.5c-512mb`) | $7.00 |
| | | **Total** | **≈ $20.30** |

`render.yaml` (the "Blueprint") describes exactly these three. It contains **no secrets**. No Redis, no extra disks, no autoscaling. **Auto-deploy is off**: pushing to GitHub never redeploys by itself.

Why not the free plans: Render has no free background worker, a free web service sleeps after 15 minutes (judges would wait ~1 minute on first load and PayPal webhooks would arrive late), and a free database is deleted after 30 days.

PayPal stays in **Sandbox** throughout (`PAYPAL_ENV=sandbox`; PayFlow refuses to start against live PayPal). The deployment uses the **existing PixelForge US Sandbox merchant app** — do not create a new PayPal app.

## 1. Before you start (on your computer, once)

You need: Node 24, `pnpm` (via `corepack enable`), Git, and this repository.

```bash
git clone https://github.com/LISK819129/Payflow.git
```

```bash
cd Payflow
```

```bash
corepack enable
```

```bash
pnpm install
```

If this computer has no `.env.local` yet (a fresh clone), create one, then open it in a text editor and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (PixelForge Sandbox app, from developer.paypal.com → Apps & Credentials → Sandbox) and `OPENAI_API_KEY`. The deploy commands use these to talk to PayPal Sandbox and to check the OpenAI key. The file is git-ignored; never paste these values anywhere else.

```bash
pnpm env:init
```

Check the Blueprint before creating anything:

```bash
pnpm deploy:check
```

Expected:

```
PASS  render.yaml — exactly the 3 approved resources, 1 web instance, auto-deploy off, no secrets in the file
        payflow-db — database, plan 0.1c-256mb, ~$6.30/month
        payflow-web — web, plan 0.5c-512mb, ~$7.00/month
        payflow-worker — worker, plan 0.5c-512mb, ~$7.00/month
      Expected cost — ~$20.30/month (charged per second while the resources exist)
      Render will ask for (payflow-web) — PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, OPENAI_API_KEY, SEED_OWNER_PASSWORD
      Render will ask for (payflow-worker) — PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, OPENAI_API_KEY
WARN  Render validator — file accepted; Render needs a payment method before it can create 3 paid resources
```

The WARN is expected until §2 is done (it only appears if the optional Render CLI is installed and logged in). After §2 it becomes `PASS  Render validator — Render accepts render.yaml`. Any **FAIL** means `render.yaml` was changed — do not continue; `git checkout render.yaml`.

## 2. Add Render payment method

1. Sign in at **dashboard.render.com**. Top-left, make sure the workspace is **paypal** (the one with the hackathon credit).
2. Left sidebar → **Workspace Settings** (or your avatar → *Workspace settings*) → **Billing**.
3. **Add payment method** (or *Add card*) → enter the card in Render's own form → **Save**.

## 3. Confirm hackathon credit

Still on **Billing**: the **Credits** (or *Promotional credits*) panel should show the hackathon credit (about $50) as available. Usage is charged against it first. If it is not there, stop and sort that out with Render before continuing — §6 starts the meter.

## 4. Create Blueprint from LISK819129/Payflow

1. Top right **+ New** → **Blueprint**.
2. Connect the GitHub repository **LISK819129/Payflow** (if it is not listed: *Configure GitHub* → allow access to that repository).
3. **Blueprint name:** `payflow` · **Branch:** `main` · **Blueprint path:** `render.yaml` (the default).
4. Render reads the file and shows the resources it will create. Check it lists **exactly three**:
   - `payflow-db` — PostgreSQL — Basic-256mb
   - `payflow-web` — Web Service — Starter
   - `payflow-worker` — Background Worker — Starter

   If you see anything else (another service, Redis, a different plan), **stop** — do not apply.

## 5. Enter secrets

On the same page Render asks for the values marked `sync: false`. Type or paste them **into Render only**:

| Service | Variable | Value |
|---|---|---|
| payflow-web | `PAYPAL_CLIENT_ID` | PixelForge US Sandbox app → Client ID |
| payflow-web | `PAYPAL_CLIENT_SECRET` | PixelForge US Sandbox app → Secret |
| payflow-web | `OPENAI_API_KEY` | the OpenAI key |
| payflow-web | `SEED_OWNER_PASSWORD` | a **new** strong password for the judge login (16+ characters, not used anywhere else). Keep it in your password manager; you will give it to judges privately. |
| payflow-worker | `PAYPAL_CLIENT_ID` | same as web |
| payflow-worker | `PAYPAL_CLIENT_SECRET` | same as web |
| payflow-worker | `OPENAI_API_KEY` | same as web |

Everything else comes from `render.yaml` and needs no typing: `DATABASE_URL` (from `payflow-db`), `SESSION_SECRET` (generated by Render), `PAYPAL_ENV=sandbox`, `PAYPAL_WEBHOOK_ID=9MJ408823R309725D`, the judge login `SEED_OWNER_EMAIL=judge@payflow.demo`, the demo suppliers (Acme Cloud → `sb-yluat53193698@personal.example.com`, AWS Demo → `sb-mnylb53193692@personal.example.com`), the AI caps ($1 per 24 h, $5 total) and rate limits. `APP_URL` is not set: PayFlow uses Render's own `https://…onrender.com` address.

## 6. Apply

Press **Deploy Blueprint** (older Render screens call it **Apply**). Billing starts now.

## 7. Wait for 3 resources

Dashboard → **Blueprints → payflow** (or the main *Projects/Services* list). Wait until:

- `payflow-db` → **Available** (~2 min)
- `payflow-web` → **Live** (~5–8 min: install, `next build`, then the pre-deploy step runs `pnpm db:migrate && pnpm db:seed` — the migrations and the judge login — then it starts)
- `payflow-worker` → **Live** (log shows `[worker] listening on paypal-event-route, run-advance, …`)

In the browser, `https://<your-app>.onrender.com/api/health/ready` should show `"status":"ready"`.

Now copy two values into a file on your computer. Run any deploy command once; it creates the file and stops:

```bash
pnpm deploy:setup
```

```
Created .env.deploy.local. Fill in DEPLOY_URL and DEPLOY_DATABASE_URL (instructions inside), then run the command again.
```

Open `.env.deploy.local` (git-ignored) in a text editor:

- `DEPLOY_URL=` Render → **payflow-web** → the URL under the name at the top, e.g. `https://payflow-web.onrender.com` (yours may have a suffix like `payflow-web-x1y2`).
- `DEPLOY_DATABASE_URL=` Render → **payflow-db** → **Connect** (top right) → **External** tab → **External Database URL** (copy button). It starts `postgresql://` and its host ends in `.render.com`. Not the *Internal* one — the command will tell you if you picked that.

## 8. Run setup

```bash
pnpm deploy:setup
```

Expected (first run):

```
PASS  Web service — answers /api/health
PASS  Database schema — up to date (13 migrations), job queues ready
PASS  Judge login — judge@payflow.demo is the workspace owner
PASS  Demo setup — created and activated "Cloud procurement"; created and activated "Customer refunds"; created authority "Cloud procurement"; created authority "Customer refunds"; registered a new Cloud Procurement Agent (credential shown once)
      Suppliers — Acme Cloud → sb-yluat53193698@personal.example.com; AWS Demo → sb-mnylb53193692@personal.example.com
PASS  Demo agent credential — new Cloud Procurement Agent registered; credential saved to .env.agent.deploy.local (not printed)

deploy:setup: 5 passed, 0 warning(s), 0 failed
```

It is safe to run again any time: a second run says `already as configured — nothing changed`. It never moves money, never contacts PayPal or OpenAI, never deletes anything. The demo agent's credential goes to `.env.agent.deploy.local` (git-ignored, never printed); your local development credential in `.env.agent.local` is not touched. `--rotate-agent` issues a fresh credential if the old one may have leaked.

## 9. Configure PayPal webhook

PayPal must send events to the deployed site. The Sandbox app already has PayFlow's webhook (`9MJ408823R309725D`, currently pointing at an old development tunnel). This **moves** it — same id, no duplicate.

Preview first (read-only, changes nothing):

```bash
pnpm deploy:webhook https://payflow-web.onrender.com --dry-run
```

```
Target:   https://payflow-web.onrender.com/api/webhooks/paypal
Existing: 9MJ408823R309725D → https://….trycloudflare.com/api/webhooks/paypal
Action:   MOVE the existing webhook (same id)

--dry-run: nothing changed.
```

Then for real (use **your** URL from §7):

```bash
pnpm deploy:webhook https://payflow-web.onrender.com
```

```
Done: updated webhook 9MJ408823R309725D → https://payflow-web.onrender.com/api/webhooks/paypal
PAYPAL_WEBHOOK_ID is 9MJ408823R309725D — already set in render.yaml; nothing to change in Render.
```

It refuses to move anything until the site reports ready. It also removes other *PayFlow* webhooks left by old tunnels, never touches webhooks for other apps, and only creates a webhook if none exists. If it prints `IMPORTANT: the webhook id is …, not 9MJ408823R309725D` (only if the webhook had been deleted by hand), set `PAYPAL_WEBHOOK_ID` to the printed id on **both** services (Render → service → **Environment** → edit → **Save, rebuild and deploy**).

## 10. Run verification

```bash
pnpm deploy:verify
```

Expected — every line PASS (lines without a mark are information):

```
PASS  Web liveness — /api/health → 200
PASS  Readiness — /api/health/ready → 200 ready
PASS    database — ok
PASS    migrations — current
PASS    paypal — configured
PASS    paypalWebhook — configured
PASS    ai — configured
PASS    worker — recent
PASS  Security headers — login page 200; frame-ancestors none, nosniff, no X-Powered-By
PASS  MCP refuses strangers — unauthenticated POST /api/mcp → 401
PASS  MCP as the demo agent — 7 tools; Cloud Procurement Agent ACTIVE; may request payout via Cloud procurement (LIVE+TEST)
PASS  Judge login — judge@payflow.demo (OWNER)
PASS  Demo setup — 2 demo flows (Cloud procurement ACTIVE, Customer refunds ACTIVE); 2 authorities; agent Cloud Procurement Agent until …; suppliers mapped
PASS  Worker version — last seen 12 s ago, running <commit> (origin/main is <commit>)
      AI spend (hosted) — last 24 h: 0 calls $0.0000 (cap $1/day in render.yaml); total 0 calls $0.0000 (cap $5)
PASS  Audit chain — 10 records, intact
PASS  PayPal webhook — 9MJ408823R309725D delivers to https://payflow-web.onrender.com/api/webhooks/paypal
PASS  OpenAI key — valid (checked with the free model list — no tokens spent)

deploy:verify: 18 passed, 0 warning(s), 0 failed
```

It moves no money and spends no OpenAI credit. Exit code 0 = all good, 1 = something FAILed (each FAIL prints `→` what to do). Two optional extras:

- `pnpm deploy:verify --scenarios` — also runs the three judge Test Runs through the MCP agent interface and checks the verdicts (`$185 Acme → WOULD_ALLOW`, `$470 gift cards → WOULD_REVIEW`, `$650 AWS → WOULD_REVIEW`). Test Runs never contact PayPal. The first run costs about **$0.02** of OpenAI; repeats replay the stored answers for $0.
- `pnpm deploy:verify --webhook-test` — proves PayPal really delivers to the site: creates **one harmless Sandbox catalog product** (no money) and waits up to 3 minutes for PayPal's `CATALOG.PRODUCT.CREATED` to arrive, be signature-verified and processed by the worker.

## 11. Login as judge

Open `https://<your-app>.onrender.com` → **Sign in** with `judge@payflow.demo` and the password you entered as `SEED_OWNER_PASSWORD` in §5. You should land on the Home page with **PayPal · Sandbox** shown and **Try PayFlow**.

Give judges the URL, the email and the password **privately** (not in the public README or Devpost text).

## 12. Run judge Test Run scenarios

In the app as the judge: left menu **Flows** → **Cloud procurement** → **Test this flow** → under *Fill in an example* pick each one → **Run test**:

| Example | Expected verdict | Why |
|---|---|---|
| $185 · Acme Cloud · GPU compute | **WOULD ALLOW** | Supplier ✓ Currency ✓ Amount ✓ Budget ✓ Purpose ✓ Risk ✓ |
| $470 · Acme Cloud · digital gift cards | **WOULD REQUIRE REVIEW** | Purpose ✕ — gift cards are not cloud infrastructure (AI evidence) |
| $650 · AWS · GPU compute | **WOULD REQUIRE REVIEW** | Amount ✕ — exceeds the $500 delegated limit by $150 |

Each is marked *Test input* — PayPal is never contacted and no budget is reserved. The **Demo guide** page (left menu) walks judges through the rest in ~5 minutes.

Deployment done. ✔

---

## Everyday commands

| Command | Does | Money / AI |
|---|---|---|
| `pnpm deploy:check` | Validates `render.yaml` (and Render's validator if the CLI is installed) | none |
| `pnpm deploy:setup` | Migrations check, judge login check, demo setup + suppliers, agent credential | none |
| `pnpm deploy:webhook <url> [--dry-run]` | Moves the PayPal Sandbox webhook to `<url>` (same id, no duplicates) | none |
| `pnpm deploy:verify [--scenarios] [--webhook-test]` | PASS/WARN/FAIL health of the whole deployment | none / ~$0.02 once / one Sandbox product |
| `pnpm deploy:judge-password` | Sets a new judge password (typed hidden, twice) and ends their sessions | none |

All of them read `.env.deploy.local` (except `deploy:check` and `deploy:webhook`, which take no target). None prints a secret.

**Redeploying new code** (auto-deploy is off): push to `main`, then Render → **payflow-web** → **Manual Deploy → Deploy latest commit**, and the same on **payflow-worker**. Then `pnpm deploy:verify` (the *Worker version* line compares the running commit with `origin/main`).

**Resetting the demo for the next judge:** sign in as the judge → **Settings → Restore demo setup** (only demo records are touched), or run `pnpm deploy:setup`.

**Talking to the deployed site as the demo AI agent** (optional). In PowerShell, this lists the agent's tools — read-only:

```bash
$env:AGENT_TOKEN_FILE=".env.agent.deploy.local"; $env:PAYFLOW_MCP_URL="https://payflow-web.onrender.com/api/mcp"; pnpm agent:mcp tools
```

`pnpm agent:mcp call payflow_request_payment …` makes a **real** request: one within the authority (e.g. $185 to Acme Cloud) executes a real **Sandbox** payout; one over it waits for a person.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `deploy:check` FAIL | `render.yaml` was edited. `git checkout render.yaml`. |
| Render shows more or different resources than §4 | Wrong branch/file. Cancel; pick branch `main`, path `render.yaml`. |
| payflow-web **Deploy failed** during *pre-deploy* with `Unsafe production configuration` | The log lists each problem. Usually a missing secret: Render → payflow-web → **Environment** → add it → **Save, rebuild and deploy**. |
| … `Database encoding is …; PayFlow requires UTF8` | The database is not UTF8 — only happens with a hand-made database. Use the Blueprint's `payflow-db`. |
| `/api/health/ready` → `"worker":"not_seen"` | payflow-worker is not running: Render → payflow-worker → **Logs**. If it says `Invalid server environment`, its secrets are missing (§5). |
| `"paypal":"missing"` or `"ai":"missing"` | That secret is missing on that service. Add it on **both** services. |
| `deploy:setup` says *That is Render's Internal Database URL* | Copy the **External** Database URL (§7). |
| `deploy:setup` / `verify` → `cannot reach … ECONNREFUSED/ENOTFOUND` | Wrong `DEPLOY_URL`, or payflow-web is not Live yet. |
| `deploy:setup` → database `timeout` / `ECONNRESET` | Render → payflow-db → **Networking/Access Control** must allow your IP (default: allow all). |
| `Judge login — judge@payflow.demo does not exist` | `SEED_OWNER_PASSWORD` was empty at first deploy. Set it on payflow-web → **Save, rebuild and deploy** (the pre-deploy creates it), then `pnpm deploy:setup`. |
| Forgot the judge password | `pnpm deploy:judge-password`. (Changing `SEED_OWNER_PASSWORD` in Render does **not** change an existing login.) |
| `deploy:webhook` → `PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET … must be in .env.local` | §1: `pnpm env:init`, then add the two values in a text editor. |
| `deploy:webhook` → `… is not ready` | Finish §7–§8 first; PayPal must not deliver to a site that cannot verify events. |
| `deploy:verify` WARN *PayPal webhook — points at …* | Run §9. |
| `--webhook-test` FAIL after 3 minutes | Check §9 ran; Render → payflow-web → **Logs** for `[webhook] rejected` (a wrong `PAYPAL_WEBHOOK_ID` makes signatures fail). |
| `MCP as the demo agent` FAIL `401` | The credential was rotated elsewhere: `pnpm deploy:setup --rotate-agent`. |
| Test Run says the AI is unavailable / `AI_DAILY_CAP` reached | The $1/24 h cap protects the credit. Wait, or raise `AI_DAILY_CAP_USD` on both services (it costs money). |
| Judges see `Too many failed attempts. Try again later.` | Login throttling after wrong passwords (per IP and per account); wait a few minutes. |

## After judging: delete everything

Billing stops only when the resources are **deleted** (suspending a service still bills the database).

1. Render → **payflow-web** → **Settings** → scroll to the bottom → **Delete Web Service** → type the name → confirm.
2. **payflow-worker** → **Settings** → **Delete Background Worker** → confirm.
3. **payflow-db** → **Settings** (or *Info*) → **Delete Database** → confirm. This destroys all hosted data (the audit trail included); export anything you want first (e.g. screenshots, or `pg_dump` with the External URL).
4. **Blueprints → payflow → Settings → Delete Blueprint** (removes the link to the repository).
5. **Billing** → check no PayFlow resource is still listed.
6. On your computer, delete `.env.deploy.local` and `.env.agent.deploy.local`.
7. Optional: the PayPal Sandbox webhook now points at a dead URL — harmless. To use it for local development again: `pnpm paypal:webhook:register https://<your tunnel>` (moves it back, same id).

Never commit `.env.local`, `.env.deploy.local`, `.env.agent.local` or `.env.agent.deploy.local` (all git-ignored).

---

## Reference

**How it runs.** `payflow-web` is the Next.js app, API, MCP server for AI agents (`/api/mcp`) and the PayPal webhook receiver. `payflow-worker` runs pg-boss jobs: workflow steps, PayPal event routing, timers, observations. Both share `payflow-db`.

- **Node** 24 (`NODE_VERSION=24`); **pnpm** from `packageManager` via corepack. `NODE_ENV` is not set in the Blueprint: Render sets `production` at runtime, and setting it at build time would make pnpm skip the dev dependencies `next build` needs.
- **Pre-deploy** (web): `pnpm db:migrate && pnpm db:seed`, both idempotent. Migrate refuses a non-UTF8 database, applies the Drizzle migrations and creates the job queues; seed creates the judge login if missing.
- **Health:** `GET /api/health` (liveness); `GET /api/health/ready` (readiness: database reachable, migrations current, which integrations are configured, whether a worker heartbeat is recent — states only, never values). Render's health check uses the readiness endpoint.
- **One web instance.** Login, MCP, AI-drafting and Test Run rate limits are in-process, which is correct only with exactly one instance. The money guards (AI caps, authority, budgets, idempotency) are in Postgres.
- **Production safety checks** stop the app from starting with: live PayPal, a local or reused development database password, a short database password, a placeholder `SESSION_SECRET`, half-set PayPal credentials, simulator events enabled, or demo mode with AI and no daily cap. `PAYFLOW_ALLOW_LOCAL_DB` exists only for a local rehearsal — never set it on Render.

**Environment variables** (all set by `render.yaml` except the `sync: false` ones in §5):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | From `payflow-db` (`fromDatabase`) — a new credential. |
| `APP_URL` | Not set; defaults to Render's `RENDER_EXTERNAL_URL`. Must be https on the web service; the worker serves no URLs. |
| `SESSION_SECRET` | Generated by Render (256-bit). Only the web service signs sessions. |
| `PAYPAL_ENV` | `sandbox` — the only accepted value. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | The existing PixelForge US Sandbox app (`sync: false`). |
| `PAYPAL_WEBHOOK_ID` | `9MJ408823R309725D`, the existing Sandbox webhook (a public identifier). |
| `PAYPAL_ALLOW_SIMULATOR_EVENTS` | `false`. |
| `AI_PROVIDER`, `OPENAI_API_KEY` | `openai` and the key (`sync: false`). Never exposed to agents or the browser. |
| `AI_BUDGET_USD` / `AI_DAILY_CAP_USD` | $5 lifetime / $1 rolling 24 h on this database. |
| `AI_COMPILES_PER_USER_PER_HOUR`, `AI_COMPILES_PER_WORKSPACE_PER_DAY`, `TEST_RUNS_PER_USER_PER_HOUR` | 12 / 60 / 60. |
| `PAYFLOW_DEMO_MODE` | `true`: enables *Settings → Restore demo setup*. |
| `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` | `judge@payflow.demo` and the password you choose (`sync: false`). |
| `DEMO_SUPPLIER_ACME_EMAIL`, `DEMO_SUPPLIER_AWS_EMAIL` | The two PayPal Sandbox personal accounts that receive demo payouts (identifiers, not secrets). A payout to them ends **Settled**. |
| `TRUSTED_PROXY_HOPS` | `1` (Render's proxy) — how the caller's IP is read. |
| `PAYFLOW_WORKER_WATCH` | `0` on the worker. |

**Local rehearsal** (how the deploy commands were tested without Render): a fresh UTF8 database on the local Postgres; `pnpm db:migrate && pnpm db:seed` with `SEED_OWNER_EMAIL=judge@payflow.demo` (what Render's pre-deploy does); a git-ignored `.env.production.local` with that `DATABASE_URL`, `PAYFLOW_ALLOW_LOCAL_DB=true`, `APP_URL=http://localhost:3000`, `PAYFLOW_DEMO_MODE=true`, `AI_DAILY_CAP_USD`; `pnpm build && pnpm start`; `pnpm worker` with the same `DATABASE_URL`; `.env.deploy.local` pointing at `http://localhost:3000` and that database; then `pnpm deploy:setup --allow-local` and `pnpm deploy:verify --allow-local`. Output: `evidence/phase11/`.
