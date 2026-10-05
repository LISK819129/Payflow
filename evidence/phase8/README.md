# Phase 8 evidence — Test Run and Observe Mode

Date: 2026-10-05 · PayPal **US Sandbox** (no real money) · `manifest.json` is generated from the database (`pnpm evidence:manifest:phase8`). Screenshots: 1920 px wide, the real app in Microsoft Edge.

**Not forecasting.** Neither feature predicts anything. A Test Run shows how one saved workflow version handles one hypothetical transaction *now*; an observation shows how a draft evaluated one real PayPal event *at that moment*. Each result says live results can differ if the transaction, authority, budgets, workflow version, AI analysis or PayPal state change.

**No simulated money movement occurred anywhere in this phase.** Every Test Run and observation ran the real engine inside a database transaction that was rolled back; PayPal was not contacted by any of them. "Would send" means exactly that: the payout was prepared, authorised by the engine, and stopped before contact.

## Cost and side effects this phase

| | |
|---|---|
| OpenAI | **0 calls, $0.00**. Dev server and worker ran with `AI_PHASE_CAP_USD=0`: any model call is refused before it is made. Lifetime unchanged: 32 calls, $0.386817 |
| PayPal money movement | **none** — no payout, refund, capture, payment or invoice |
| PayPal objects created | one Sandbox catalog product `PROD-9JK887907T391174J` and one billing plan `P-2F6347026D165282UNLBQRNY` (no subscriber, no payment) — only to make PayPal emit a real, harmless webhook |
| Live rows created by tests/observations | 0 action executions, 0 budget reservations, 0 approvals, 0 authority decisions, 0 reconciliations, 0 workflow runs (`manifest.liveRowsCreatedSincePhaseStart`) |
| Audit chain | verified (`manifest.auditChain`) |

## Labels

| Label | Meaning |
|---|---|
| `TEST_INPUT` | a hypothetical transaction a person typed into *Test this flow*. Never a PayPal event |
| `REAL_PAYPAL_EVENT_OBSERVED` | a real PayPal Sandbox webhook, signature-verified, **confirmed with PayPal's event API**, routed live first, then evaluated by an observing draft |
| `CACHED_AI_ANALYSIS` | a real OpenAI (`gpt-5.4-mini`) result computed and paid for in **Phase 7**, reused from the content-addressed cache — **no new model call** |
| `MOCK_TEST` | the deterministic mock analyst (`AI_ANALYSIS_PROVIDER=mock`) — no model was called; keyword rules, not intelligence |
| `AI_UNAVAILABLE` | the model call was refused before it was made (the $0 cap); policy treats it as UNCERTAIN → review |
| `CALCULATED_BY_PAYFLOW` | PayFlow's own rules over its own records; no AI |

## Test Runs (TEST_INPUT) — workflow "Cloud procurement" v2, authority "Cloud procurement" v4

| Folder | Input | AI labels | Verdict | Why |
|---|---|---|---|---|
| `1-normal/` | Acme Cloud $185, INV-8122 GPU compute, with contract | MOCK_TEST | **WOULD ALLOW** | every check passes; payout to `billing@acme-cloud.example` *would* be sent — **not sent, PayPal not contacted** |
| `2-purpose-violation/` | Acme Cloud $470, "10 x $47 digital gift cards" (the exact Phase 7 invoice) | **CACHED_AI_ANALYSIS** (extract, purpose) | **WOULD REQUIRE REVIEW** | approved supplier, ≤ $500, USD, budget ✓ — but the purpose is OUTSIDE the delegated scope |
| `3-financial-limit/` | Acme Cloud $650, INV-8123 | MOCK_TEST | **WOULD REQUIRE REVIEW** | $650 exceeds the $500 per-transaction limit; budget snapshot shown, nothing reserved |
| `4-unknown-supplier/` | Nimbus Compute $120 | MOCK_TEST | **WOULD REQUIRE REVIEW** | not an approved counterparty; never paid before → risk ELEVATED |
| `5-approval-exploration/` | from the gift-card test: *Assume approved* / *Assume rejected* | CACHED_AI_ANALYSIS | WOULD ALLOW (after the assumed approval, not sent) / WOULD END WITHOUT PAYPAL | the assumption exists only inside the test; no approval was created and nothing was authorised |
| `7-ai-cap-refusal/` | gift-card invoice with real line breaks (not byte-identical to Phase 7, so a cache miss) | **AI_UNAVAILABLE** | WOULD REQUIRE REVIEW | the $0 cap refused both model calls before they were made — the flow failed safe to review, $0 spent |

Each result page shows: the TEST RUN banner, **PayPal: Not contacted**, **Money moved: $0**, **Real budget reserved: $0**, the path highlighted on the graph, what each step did, the authority trace evaluated against a budget snapshot, and the Intelligence panel with per-analysis labels.

## Observe Mode (REAL_PAYPAL_EVENT_OBSERVED) — `observe/`

1. `01`, `02` — the owner switched **Observe** on for the DRAFT "New subscription plan review" (`pnpm db:seed:phase8`; trigger `BILLING.PLAN.CREATED` → finance confirms → end). It was never activated.
2. `pnpm paypal:sandbox:plan` created a Sandbox product and billing plan. PayPal sent two real webhooks:
   - `WH-95695264SV199530G-7JV32686XH072420A` — `BILLING.PLAN.CREATED`
   - `WH-5AN868774B986251R-4PR551388J948141Y` — `CATALOG.PRODUCT.CREATED`
3. The worker routed each **live first** (`confirmed: true` with PayPal's API; no active workflow listens for them, so no run started), then queued the separate observe job.
4. The draft observed the plan event: **WOULD REQUIRE REVIEW** — "would wait for a person". The product event did not match its trigger and was not observed. `04` shows the result, `03` the observation feed, `05` the live events page.
5. Before vs after the observation: approvals 15 → 15, workflow runs 39 → 39, run steps 200 → 200, action executions 27 → 27, budget reservations 7 → 7, authority decisions 18 → 18, reconciliations 2 → 2, AI usage 32 → 32. The approval the draft would have requested existed only inside the rolled-back transaction.

## Isolation — `6-isolation/`

Captured after every test and observation above: the Authority page (spent and reserved unchanged), Approvals (no request from any test), Transactions (no execution from any test) and the Audit log (`simulation.test_run` lines: *"TEST RUN — no money moved, PayPal not contacted"*).

## Deterministic tests — `tests/simulation.test.ts`, 23 tests

The five demo scenarios, the 20 required safety cases, and records/cache/cap cases, against a fake PayPal that records any call (it must record none). Highlights:
- **20** — code that deliberately tries to pay from inside a sandbox is refused at every layer: no write capability can be minted, the gateway refuses, the HTTP client refuses any non-GET, the SDK refund/capture refuse.
- **16** — a test and a live payment at the same moment: the live one reserves and pays once; the test reserves nothing.
- **17** — editing a draft while observing: old observations keep the exact graph they used.
- **19** — a forged request to run a simulation as LIVE is refused.
- A **$0 phase cap** refuses the model call before it is made: AI_UNAVAILABLE, review, nothing spent.
- Architectural checks: making the sandbox **commit** instead of roll back fails 11 tests; removing the sandbox's no-PayPal action port fails 6.

## Records superseded during capture (all still in `manifest.json`)

Honesty fixes made while capturing, each now covered by a test; the earlier records keep their original stored text:
- The engine described the trigger of a test/observation as "Started manually with a user-provided payload". The observation (`5a3bfc4e…`) was recorded before the fix; its page now states its provenance from the record (`REAL_PAYPAL_EVENT_OBSERVED`, event id).
- An assumed rejection was headlined "rejected by a person" (`bbc58f17…`); now "After the assumed rejection (only inside this test)…" (`679256bf…`).
- Analyses computed for a test were shown as "reused from cache" (`0dc7aa70…`, `a416638e…`, `1ffe132a…`, MOCK_TEST); they are now marked as computed for the test, and only real cache hits say cached. The payout step said "sending to PayPal Sandbox"; it now says it was stopped before any contact.
- A model call refused by the cap would have been labelled REAL_OPENAI; it is now AI_UNAVAILABLE.
