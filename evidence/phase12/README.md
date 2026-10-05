# Phase 12 evidence — final polish and judge rehearsal

Date: 2026-10-05 · PayPal **Sandbox** · local development database (the one `pnpm dev` uses), with the demo setup restored onto it so local testing shows the judge setup **and** the real Sandbox history from Phases 4–9.

## Cost and money

| | |
|---|---|
| OpenAI this phase | **17 calls, $0.026999** — the five judge Test Runs below, one TEST and one LIVE agent request (each analysed once). Lifetime across all databases ≈ $0.50 of the $5 budget |
| PayPal | **No transactions.** OAuth and read-only checks only. The $650 agent request was left **waiting for a person** — PayPal not contacted. The webhook was not moved |

## Test Runs on the local judge setup (TEST_INPUT; real engine; PayPal not contacted)

| Folder | Input | Verdict |
|---|---|---|
| `01-local-test-runs/01–02` | $185 · Acme Cloud (Sandbox `sb-yluat53193698@personal.example.com`) · GPU compute | **WOULD ALLOW** |
| `01-local-test-runs/03–04` | $470 · Acme Cloud · digital gift cards | **WOULD REQUIRE REVIEW** — Purpose ✕ (AI evidence; the policy decided) |
| `01-local-test-runs/05–06` | $650 · AWS Demo (`sb-mnylb53193692@personal.example.com`) · GPU compute | **WOULD REQUIRE REVIEW** — $650.00 exceeds the $500.00 limit |
| `02-unknown-supplier/` | $120 · `billing@unknown-cloud.example` | **WOULD REQUIRE REVIEW** — not an approved counterparty |
| `03-denied-supplier/` | $120 · `payments@blocked-vendor.example` | **WOULD DENY** — Blocked Vendor is on the deny list; PayPal not contacted |

The demo suppliers are now the two real Sandbox personal accounts (identifiers only — no passwords are stored), locally and in `render.yaml`.

## What changed for judges

- README rewritten as the public front page, with an original SVG logo (`docs/assets/payflow-logo*.svg`, Instrument Sans outlines + a highlighter stroke) and current screenshots (`docs/assets/screens/`).
- `docs/JUDGE_TESTING.md` (start/stop on Windows, an 18-step rehearsal, optional live Sandbox guide), `docs/DEMO_VIDEO.md`, `docs/DEVPOST_SUBMISSION.md`.
- Home and login now say what PayFlow is: *the financial permission layer between AI agents and real money*.
- Audit: search (request reference, PayPal id, run id, words) and paging back through the whole chain; plain headings for every record kind.
- Approvals show PayPal's settlement (e.g. *Awaiting recipient*) instead of the submission status.
- Settings: product wording for PayPal permissions; the AI model shown is the one actually used.
- Demo guide step 5 works when no request is waiting (requests for a person expire after 24 h).
- 404 / error pages padded like every other page; no Next.js dev badge over the product.
- Agent demo client discovers its workflow and uses fresh request ids; ready-made requests in `scripts/agent-demo/requests/`.
