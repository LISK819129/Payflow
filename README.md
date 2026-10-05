# PayFlow

**Give AI permission to ask. PayFlow decides whether money moves.**

PayFlow lets people and AI agents automate PayPal payments without giving AI unrestricted control over money. You describe what your money should do; AI drafts the workflow; you test it safely and give it a *delegated authority* — who it may pay, how much, how often, and for what purpose. From then on, every payment a workflow or an external AI agent asks for is checked against those rules **and their meaning**, a person is asked when it goes beyond them, and only then does PayPal settle.

> AI proposes and requests. PayFlow authorizes. PayPal settles.

Built for the PayPal AI Hackathon 2026. Runs against **PayPal Sandbox only** — no real money.

## Why

Payment automation and AI agents are converging, but the usual integration hands an agent PayPal credentials: full merchant access, no notion of purpose, no budget, no person in the loop. PayFlow is the control plane in between:

```
AI agent ─► PayFlow MCP ─► identity & scope ─► Intent Receipt ─► workflow ─► AI analysis
        ─► delegated authority (amount · recipient · currency · budget · frequency · purpose)
        ─► human approval if needed ─► final request-integrity check ─► PayPal ─► webhook confirmation ─► audit
```

## What makes it different

- **Purpose, not just limits.** A $470 invoice from an approved supplier, in USD, under the $500 cap and within budget passes every classic check — and is still stopped, because it is for gift cards and the authority covers cloud infrastructure. The AI reads the invoice; the *authority's own policy* decides; a person approves or rejects.
- **Agents can only ask.** External AI agents get a PayFlow identity with narrow, revocable scopes and a small MCP tool surface (request, test, check status, withdraw). No tool approves, changes rules or reaches PayPal. Every request gets a hashed, audit-anchored **Intent Receipt**, and the payment PayFlow makes must match it exactly.
- **Test before money moves.** *Test this flow* runs the real decision engine inside a transaction that is always rolled back and cannot obtain a PayPal write capability. *Observe Mode* lets a draft evaluate real incoming PayPal events with the same isolation.
- **Truthful status.** "Submitted to PayPal" is not "settled": settlement comes from PayPal's own status reports (e.g. a payout item `UNCLAIMED` is shown as *Awaiting recipient*).
- **Everything is auditable** in a per-workspace hash chain; receipts and their outcome chains are verifiable.

## Try it (5 minutes)

Sign in and open **Demo guide**. The short path: open *Cloud procurement* → **Test this flow** → `$185 Acme Cloud · GPU compute` (allowed) → `$470 Acme Cloud · digital gift cards` (a person must approve: *Purpose ✕*). Then look at the Cloud Procurement Agent, an approval for `$650 AWS` (exceeds the $500 authority by $150), and its Intent Receipt.

## Architecture

Next.js 16 (App Router, Server Actions) · PostgreSQL + Drizzle · pg-boss worker · PayPal REST + server SDK · OpenAI (`gpt-5.4-mini`) behind a metered provider · MCP TypeScript SDK (Streamable HTTP).

- `src/server/workflow` — workflow DSL, validator, durable interpreter (runs pinned to versions)
- `src/server/authority` — delegated authority: check → reserve under row locks → commit/release, budgets, frequency, approvals
- `src/server/intelligence` — AI evidence nodes (invoice reading, purpose, contract, behaviour), deterministic signals, injection scanning, content-addressed cache
- `src/server/actions` — the single PayPal execution boundary (idempotency keys, leases, settlement)
- `src/server/simulation` — Test Run and Observe Mode (rolled-back sandbox, no write capability)
- `src/server/agents` — Agent Gateway: identities, envelope, idempotency, Intent Receipts, MCP server
- `src/server/webhooks` — verified PayPal webhooks, routing, confirmation

Details: [ARCHITECTURE.md](ARCHITECTURE.md) · PayPal coverage: [docs/PAYPAL_CAPABILITY_MAP.md](docs/PAYPAL_CAPABILITY_MAP.md) · security: [docs/SECURITY.md](docs/SECURITY.md) · deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · build log and evidence: [BUILD_STATUS.md](BUILD_STATUS.md), `evidence/`.

## PayPal integration

Payouts, refunds, order capture, invoicing (send, remind, reconcile), lookups and transaction search through PayPal's REST APIs and server SDK; signed webhooks for orders, captures, refunds, invoices, payouts, disputes and subscriptions, verified and confirmed with PayPal's API before they confirm anything. PayPal's own MCP server and Agent Toolkit authenticate with merchant credentials; PayFlow deliberately sits in front of PayPal rather than handing those to agents.

## AI safety model

- The model drafts workflows and interprets documents; it never holds credentials, never approves, and its output is *evidence* for deterministic policy.
- Untrusted text (invoices, contracts, agent purposes) is fenced and scanned for injected instructions by code.
- Strict schemas, one repair attempt, fail closed to human review.
- Hard spend caps enforced in code: lifetime, optional phase, rolling 24 h; per-person limits on drafting and Test Runs.

## Agents and MCP

`POST /api/mcp` (Streamable HTTP, stateless). Tools: `payflow_list_capabilities`, `payflow_request_payment`, `payflow_request_refund`, `payflow_test_request`, `payflow_get_request`, `payflow_get_authority`, `payflow_cancel_request`. Owners register agents on the **Agents** page (credential shown once, SHA-256 stored), choose what each may *ask* for, and can rotate or revoke at any time. States returned to agents distinguish `SUBMITTED_TO_PAYPAL`, `AWAITING_RECIPIENT` and `COMPLETED` (settled).

## Run locally

Requires Node 20.9+ (24 recommended) and pnpm.

```bash
pnpm install
pnpm env:init        # .env.local with generated local secrets
pnpm db:start        # embedded PostgreSQL on :54329 (keep running)
pnpm db:migrate
pnpm db:seed         # PixelForge workspace + owner (login in .env.local)
pnpm demo:restore    # optional: the demo workflows, authorities and agent
pnpm dev             # web
pnpm worker          # jobs (separate terminal)
```

Add PayPal Sandbox app credentials and an OpenAI key to `.env.local` for live Sandbox actions and AI. Webhooks need a public https URL (`pnpm paypal:webhook:register https://<host>`).

## Testing

`pnpm test` runs the suite against the `payflow_test` database: workflow DSL and runtime, authority and budgets, approvals, PayPal action boundary, webhook verification and duplicates, AI intelligence and injection, Test Run / Observe isolation, the Agent Gateway (36 adversarial tests), and judge-mode hardening. Also `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm paypal:check`.

## Deployment

Render: web service + background worker + PostgreSQL, from `render.yaml`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Sandbox disclaimer

PayFlow talks only to PayPal's Sandbox. Amounts, suppliers and payouts in the demo are test data; no real money moves. Records are labelled by where they came from (Real PayPal Sandbox, real or cached OpenAI analysis, Test run, Demo setup).

## License

MIT
