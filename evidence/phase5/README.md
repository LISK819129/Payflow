# Phase 5 evidence — PayPal action nodes on the real Sandbox

Date: 2026-10-04 · Environment: **PayPal US Sandbox** (no real money) · AI spend in this phase: **$0.00** (0 calls; lifetime $0.347525 over 13 calls).

Every workflow here was **hand-built** (`scripts/seed-phase5-flows.ts`, `USER_PROVIDED`), created as a draft, and activated by the owner in the Flow Builder UI. Every PayPal id below came back from PayPal's Sandbox API. `manifest.json` is generated from the database (`pnpm evidence:manifest:phase5`), not typed by hand. Screenshots are 1920×1080 captures of the real app in Microsoft Edge (`pnpm evidence …`, `EVIDENCE_PHASE=phase5`).

Labels: **REAL_PAYPAL_SANDBOX** — object created or read on PayPal's Sandbox · **USER_PROVIDED** — run started by a person with a typed payload · **MOCK_TEST** — automated test with a fake gateway (`tests/actions.test.ts`, never shown as PayPal activity).

## Before testing

- Worker and Cloudflare tunnel restarted; the existing webhook `9MJ408823R309725D` was re-pointed to the new tunnel (`pnpm paypal:webhook:register`), not duplicated.
- Delivery verified first: a real Sandbox product + plan produced `CATALOG.PRODUCT.CREATED` and `BILLING.PLAN.CREATED`, both self-verified and routed by the worker.

## What ran (all REAL_PAYPAL_SANDBOX)

| Folder | Workflow | What happened | PayPal ids |
|---|---|---|---|
| `refund-desk/` | Refund desk | $80 refund under the $100 limit → policy gate → refund → `PAYMENT.CAPTURE.REFUNDED` webhook confirmed it | capture `1BA746057B4088914` → refund `9CL93909WG926700C` |
| `refund-desk/` | Refund desk | $150 over the limit → **waited for the owner, 0 PayPal calls** → approved in the UI → refund | capture `7B872764UT826153C` → refund `70387968X56817604` |
| `refund-failure/` | Refund desk | Refund an already fully-refunded capture → PayPal 422 `CAPTURE_FULLY_REFUNDED`, `debug_id f784808e4ab59`, run → needs review | — |
| `refund-failure/` | Refund desk | $95 on a capture with $90 left → PayPal 422 `REFUND_AMOUNT_EXCEEDED`, `debug_id f59904661b3a7` | — |
| `supplier-payouts/` | Supplier payouts | $125 to an approved supplier, **Start clicked twice** → 2 POSTs reached the server, 1 run, 1 payout; batch confirmed by `PAYMENT.PAYOUTS-ITEM.UNCLAIMED` (example.com receiver has no PayPal account) | batch `2DSJUHUB3A8CN` |
| `supplier-payouts/` | Supplier payouts | Unknown supplier → blocked by the counterparty policy; **PayPal never called** | — |
| `client-invoicing/` | Client invoicing | $1,200 invoice created + sent; client's bank transfer recorded → `INVOICING.INVOICE.PAID` | `INV2-XKNS-YUUN-4XJY-Q328` |
| `invoice-reminder/` | Overdue invoice reminder | Owner approval → reminder sent; status is the invoice's real status re-read from PayPal (`SENT`) | `INV2-XKNS-YUUN-4XJY-Q328` |
| `reconcile/` | Reconcile paid invoices (v2) | Triggered by the real `INVOICING.INVOICE.PAID` webhook → re-read the invoice from PayPal (`MARKED_AS_PAID`) → matched the **amount actually paid** (850.00) → ledger row with payment `EXTR-69J92669RM121742T` | `INV2-3REM-EZJK-GY57-2WXL` |
| `order-capture/` | Capture approved orders | Already-captured order → `ORDER_ALREADY_CAPTURED`; wrong expected amount → `AMOUNT_MISMATCH` (both after a real GET, before any capture); unapproved order → PayPal's own 422 `ORDER_NOT_APPROVED` | orders `5TY33142VT054491W`, `1JR68800AM761384H` |
| `activity-check/` | PayPal activity check | Read-only lookup (capture shows `REFUNDED`) + 7-day transaction search (6 rows) | `1BA746057B4088914` |
| `idempotency/` | Refund desk, Supplier payouts | Crash-after-send replay on real Sandbox — see below | refund `3B5520949P604025P`, batches `SWKXBFQR2EWXY`, `UM2QM3S7JCSDC` |
| `ledger/` | — | Transactions page (every action), audit timeline, PayPal events | — |
| `incident-stale-worker/` | Refund desk | A leftover worker from an earlier session (pre-Phase-5 code) claimed the first run and refused the refund node as "cannot run yet". Fail-closed: nothing was sent. Stale workers stopped; the run was repeated | — |

## No duplicate money: real Sandbox crash replay (`idempotency/real-sandbox-crash-replay.json`)

`pnpm paypal:idempotency:check` runs a real refund and a real payout through their workflows, then simulates the worst crash — PayPal accepted the call but PayFlow never stored the reply — and lets the normal recovery path re-send with the same `PayPal-Request-Id` / `sender_batch_id`. It then asks PayPal what exists.

- **Refund:** same refund id `3B5520949P604025P` on both sends; the order's refund list went 2 → 3 → **3**.
- **Payout:** PayPal refused the re-send as a duplicate batch and linked the existing one; PayFlow checked that batch's `sender_batch_id`, receiver and amount are its own and adopted it: same batch `SWKXBFQR2EWXY`, **1 item**.
- **Bug this found:** before the fix, that duplicate-batch refusal was recorded as a *failed* payout although the money had moved (batch `UM2QM3S7JCSDC`; PayPal's guard still prevented a second payout). Fixed in `createPayout`; the record was recovered through the same path and is now SUCCEEDED, and the audit chain keeps both the failure and the recovery.

The other duplicate paths are covered by MOCK_TEST tests with a fake gateway: retry with the same key after a timeout, three concurrent workers on one action (one PayPal call), two racing `runAction` calls, webhook redelivery (one run), a lost reply on invoice create (sent, not created twice), and UNKNOWN after three attempts with no definitive answer.

## Audit

`manifest.json → auditChain`: hash chain verified end to end (`ok: true`). Each action writes `action.prepared`, `action.succeeded` / `action.failed` / `action.retry` / `action.unknown`, and `action.confirmed` / `action.event` when PayPal's webhook arrives.

## Not shown here

- **Order capture success path**: needs a buyer to approve the order in PayPal checkout with a Sandbox personal account (`pnpm paypal:sandbox:order` prints the link). The capture node, its re-read and its refusals are verified; the success path is waiting on that approval.
- Partial invoice payments: the reconcile step compares the paid amount with the invoice total (unit-tested), but a real partial payment was not produced.
