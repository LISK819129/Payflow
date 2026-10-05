# Phase 10 evidence — Product hardening & Judge Mode

Date: 2026-10-05 · PayPal **Sandbox** · `manifest.json` is generated from the databases (`pnpm evidence:manifest:phase10`). Screenshots 1–15 come from a **production rehearsal**: a fresh judge database (`pnpm db:migrate && pnpm db:seed && pnpm demo:restore`), `next build` + `next start` (NODE_ENV=production) and a production-mode worker. Folder 16 comes from the development database, to show historical Phase 9 records under the new status model.

## Cost and money

| | |
|---|---|
| OpenAI this phase | **12 calls, $0.019625** — the three judge Test Runs and one agent request on the judge database (cap $0.25 enforced in code). 0 calls on the development database. Lifetime across both: $0.451354 |
| PayPal | **No transactions.** No payouts, refunds, captures or invoices; the webhook was not moved. |

## Labels

| Label | Meaning here |
|---|---|
| **REAL_OPENAI** | The judge Test Runs' analyses (shown per step as "computed for this test") |
| **TEST_INPUT** | Every Test Run: real engine, rolled back, PayPal not contacted, $0 reserved |
| **DEMO SETUP** | Workflows, authorities and the agent created by `pnpm demo:restore` — configuration only, marked `demo_key`, described "Demo setup:" |
| **REAL_PAYPAL_SANDBOX** | Only in folder 16: the Phase 9 payouts and PayPal's own webhooks about them |
| **MOCK_TEST** | `tests/phase10.test.ts` (21 tests) |

No PayPal transaction is fabricated anywhere: the judge database has 0 PayPal events and 0 executions.

## What each folder shows

| Folder | Shows |
|---|---|
| `01-judge-home/` | The new Home: the pitch, the two pipelines (person / AI agent), "Try PayFlow", live figures only, the `PayPal · Sandbox` indicator |
| `02-demo-guide/` | The 6-step, ~5-minute guide; every step opens the real product |
| `03-try-payflow/` | A "Try PayFlow" example opening the real compiler pre-filled (nothing compiled — no AI spent) |
| `04-test-185-allowed/` | Test this flow → example → **WOULD ALLOW**; Supplier ✓ Currency ✓ Amount ✓ Budget ✓ Purpose ✓ Risk ✓ → allowed automatically |
| `05-test-470-giftcards-purpose/` | **WOULD REQUIRE REVIEW**: Supplier ✓ Currency ✓ Amount ✓ Budget ✓ **Purpose ✕ (AI)** → a person must approve |
| `06-test-650-over-authority/` | **WOULD REQUIRE REVIEW**: **Amount ✕** — exceeds the delegated limit by $150 |
| `07-approval-650/` | A live request from the judge Cloud Procurement Agent (`mcp/01-judge-agent-aws-650.json`) waiting for a person: Identity ✓ Agent scope ✓ … Amount ✕ "exceeds by $150.00"; *Approve once · $650.00* — "does not change the workflow's authority". Left pending: PayPal not contacted |
| `08-agent-request-trace/` | The execution for that request: agent banner, 8-stage pipeline, checks |
| `09-intent-receipt/` | The receipt in plain words (who, what, how much, to whom, why, workflow, authority, person, PayPal, outcome), *integrity verified* |
| `10-readable-authority/` | The authority as one sentence above its structured detail |
| `11-agents/` | Agents dashboard and the judge agent: can request *Cloud procurement → payouts*; can never approve, change authority/workflows, reach PayPal, see secrets |
| `12-settings-demo-restore/` | Owner-only "Restore demo setup" (demo mode) |
| `13-audit/` | Audit trail incl. `demo.restored` |
| `14-tablet/` | Home and a Test Run result at 820 px (no horizontal scroll) |
| `15-health/` | `/api/health` and `/api/health/ready` output (states only) and the security headers |
| `16-payment-status-historical/` | Phase 9's real payouts `UBYPWTPSCT2FG` / `NPXQZ7FYERYNE` now shown as **Awaiting recipient** (PayPal item `UNCLAIMED`) instead of "Completed"; the receipt keeps its Phase 9 `final: COMPLETED` links as recorded, annotated, and adds a hash-linked `paypal_settlement` link |

## Honest notes

- The Phase 9 receipts of A and C now end `…final COMPLETED > final COMPLETED (repeat) > paypal_confirmed > paypal_settlement (AWAITING_RECIPIENT)`. Nothing was edited; the page explains each historical link.
- Screenshot 07's request was left waiting so the approval screen can be shown without moving money; the judge environment will be rebuilt on Render in Phase 11 anyway.
- Proper Sandbox recipients (so a payout ends *Settled*) need two Sandbox personal accounts created by a person in the PayPal developer dashboard — documented in `docs/DEPLOYMENT.md`, not done here.
