# Phase 6 evidence — financial policy, authority and human control

Date: 2026-10-04 · Environment: **PayPal US Sandbox** (no real money) · AI spend in this phase: **$0.00** (0 calls; lifetime $0.347525 over 13 calls).

`manifest.json` is generated from the database (`pnpm evidence:manifest:phase6`). Screenshots are 1920×1080 captures of the real app in Microsoft Edge (`EVIDENCE_PHASE=phase6 pnpm evidence …`).

Labels: **REAL_PAYPAL_SANDBOX** — sent to and returned by PayPal's Sandbox API · **USER_PROVIDED** — run started by a person with a typed payload · **MOCK_TEST** — automated test with a fake gateway (`tests/authority.test.ts`), never shown as PayPal activity.

## Setup (by the owner, in the UI)

- `authority/` — the "Cloud procurement" workflow (hand-built, `pnpm db:seed:phase6`, no AI) is activated in the Flow Builder; the owner creates its authority in the Authority form: payouts only, to Acme Cloud and AWS, never Blocked Vendor, ≤ $500 each, $2,000 a month, USD, until 31 Dec 2026.
  - v1 was saved with a malformed allowlist (my capture script joined the two suppliers into one line); the owner corrected it in the Edit form, which saved **v2**. Both versions are in the audit trail; every decision below was made under v2.
- The Phase-5 workflows were granted explicit authorities by the seed script (Customer refunds, Supplier payouts, Client billing, Checkout capture), otherwise every action they reach would now wait for a person.

## Policy → payment boundary (all REAL_PAYPAL_SANDBOX)

| Folder | Request | Authority checks | Decision | PayPal | Budget (October, $2,000) |
|---|---|---|---|---|---|
| `allow-budget-commit/` | Payout $420 → Acme Cloud | all pass | **ALLOW** | batch `3TNM3WA79KHV8` | reserved → **committed** $420 |
| `review-reject/` | Payout $850 → unknown vendor | ✕ counterparty, ✕ per-transaction | **REVIEW** → rejected by the owner | **not contacted** | nothing reserved |
| `review-approve-once/` | Payout $650 → AWS | ✕ per-transaction | **REVIEW** → approved once | batch `KFUCBL43DEV2W` | committed $650 (override, linked to the approval) |
| `deny/` | Payout $90 → Blocked Vendor | ✕ deny list | **DENY** | **not contacted** | nothing reserved |
| `double-approve/` | Payout $600 → Acme Cloud | ✕ per-transaction | REVIEW → **Approve clicked in two tabs at once** | batch `CRJ7QJKRQUDJY` — one | one decision recorded, one reservation committed |

Both approve requests reached the server (dev-server log shows two `decideApprovalAction` calls for approval `dc5cecff…`); one was accepted, the other refused as already decided.

After these runs the Authority page shows Cloud procurement at **$1,670 spent of $2,000, $330 left** (`ledger/01-authority-after-runs.png`).

## Lost PayPal reply under authority (REAL_PAYPAL_SANDBOX) — `idempotency/real-sandbox-crash-replay-under-authority.json`

The Phase-5 crash-after-send check re-run with authority in the path: refund `2K0596106M3820243` and payout batch `456LR3WMWZVTA` came back unchanged on replay (refunds on the order 3 → 4 → 4; one item in the batch), each with **one** authority decision and **one** reservation, committed once.

## Deterministic tests (MOCK_TEST) — `tests/authority.test.ts`, 27 tests

1. $500 under a $1,000 monthly budget → allowed, reserved, paid once, committed.
2. Another $600 → review (would be $1,100); PayPal not contacted; nothing reserved.
3. Two simultaneous $600 → never both authorized; five simultaneous $300 → exactly three. A test hook holds each request between reading the budget and reserving; **with the row lock removed both concurrency tests fail**, with it they pass.
4. Allowed supplier → pass; unknown → review; deny-listed → blocked.
5. USD → pass; EUR → denied (never compared to a USD budget).
6. Expired authority and not-yet-valid authority → denied; per-transaction and frequency limits → review; no authority → review; overlapping authorities must all allow; unreadable ledger → fails closed.
7. Review → approve once → exactly one payout; outcome "Completed after approval at the authority review…".
8. Two simultaneous Approve → one accepted ("Already approved" for the other), one payout; Approve and Reject at once → exactly one wins.
9. PayPal refusal after reservation → released, budget free again; no definitive answer → UNKNOWN, reservation held.
10. Lost reply → same key re-sent, one PayPal object, one decision, one reservation committed.
11. New workflow version activated while approval pending → the run finishes on its own version, once.
12. Workflow paused while waiting → approving does not pay, resuming pays once; authority suspended while waiting → approval cannot revive it (blocked); authority suspended during a retry → never re-sent, UNKNOWN, budget held.

Plus workflow-level budget/frequency nodes (race, release on failure, third pass blocked) and an audit test (decision, reservation, settlement on a verifiable chain).

## Stale-worker protection (`tooling/`)

During this phase the worker stopped itself four times (exit 75) when files it runs were edited after it started — the protection working as intended; `pnpm worker:fresh` replaced it each time. Settings → Workers shows each worker's commit and source hash against the app's, flagging stale ones.

## Not shown here

- No webhook confirmations for this phase's payouts: the Cloudflare quick tunnel reached its 2-hour background limit and was not restarted, so PayPal's webhooks for these batches were not received. Commit happens on PayPal's API answer, not on the webhook, so the budget figures above are complete.
- Order-capture success path still waits on a buyer approval (Phase 5 note).
