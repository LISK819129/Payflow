# Build Status

Last updated: 2026-10-03 · Submission deadline: **2026-11-12 12:00 PT**

Rule for this file: nothing is DONE until it has been run and verified; the verification is written next to it.

## DONE

| Phase | Item | Verified by |
|---|---|---|
| 0 | Hackathon rules, prize tracks, sponsor offers researched | Devpost rules/resources pages, 2026-10-03 |
| 0 | `docs/PAYPAL_CAPABILITY_MAP.md` | Sources listed in the file; server SDK controllers inspected from the npm tarball |
| 0 | `ARCHITECTURE.md` | — |
| 1 | Next.js 16 + TypeScript + Tailwind 4 scaffold | `pnpm typecheck`, `pnpm lint` clean |
| 1 | Local PostgreSQL 18.4 (embedded-postgres), Drizzle schema + migration `0000_init` | `pnpm db:migrate` applied; `select version()` |
| 1 | Hash-chained append-only audit log | `tests/audit.test.ts`: chain verifies; 20 concurrent appends stay gapless; edited payload and deleted record are both detected |
| 1 | Auth: scrypt passwords, DB sessions (hashed ids), login rate limit, proxy redirect | `tests/password.test.ts`; browser: wrong password rejected, correct password → dashboard, login audited |
| 1 | App shell, design tokens, provenance badges, Dashboard / PayPal events / Audit pages | Browser check, no console errors |
| 1.5 | Design-system override: white canvas, ink, fluorescent-cyan marker; Instrument Sans + IBM Plex Mono (OFL, `tnum` verified); token system; wordmark; Button/Field/Status/ProvenanceTag/Section/CopyId primitives; new login, sidebar, editorial Home, forensic Audit timeline, Events table, live Settings | `docs/DESIGN_SYSTEM.md`; contrast ratios computed (ink 19.4, muted 6.1, marker-ink 5.8, field 3.3, ink-on-marker 10.5); typecheck, lint, 37 tests, `next build` clean; inspected at 1920×1080 and 375px (no horizontal scroll) |
| **2** | **Real PayPal Sandbox integration — COMPLETE (2026-10-03)** | Evidence below |
| 1.5 | Local Postgres encoding bug: cluster had initialised as WIN1252, so any non-ASCII text failed to insert. Databases recreated as UTF8 (old ones kept as `*_win1252_old`), migrate now refuses non-UTF8, new clusters init with `--encoding=UTF8` | Regression test with non-ASCII audit text |

## IN PROGRESS

—

## BLOCKED / NEEDS USER ACTION

| Item | Needed from user | Blocks |
|---|---|---|
| PayPal Sandbox app | Credentials in `.env.local` ✓ | — |
| PayPal AI Toolkit plugin | Installed on the account 2026-10-03; loads in the next session. Its best-practices references were read directly from github.com/paypal/AI-Toolkit for Phase 2 | — |
| APIMatic Context Plugin | Installed 2026-10-03 as project skills in `.claude/skills/` (TypeScript set, pinned commit 6aa0571) because the installer needs the `claude` CLI, which this machine lacks. Loads next session. Free-subscription form still to be submitted by the user | — |
| AI provider key | Anthropic approved (provider-agnostic `AIProvider`); hard $10 budget; add `ANTHROPIC_API_KEY` | Phase 4 |
| Public webhook URL | cloudflared 2026.9.3 downloaded (Authenticode: Cloudflare, Inc., valid) | — |
| PayPal sandbox merchant | Link the app to a **US** sandbox business account (current one is India-registered: payouts + card processing refused) and enable **Invoicing** + **Transaction Search** | Scenarios A, C, overdue reminder (Phase 5) |

## Phase 2 evidence (real PayPal Sandbox, 2026-10-03)

| Check | Result | Evidence |
|---|---|---|
| OAuth client-credentials token | ✓ | app `APP-5LS059425V393790W`, 26 scopes, `expires_in` ≈ 9 h honoured |
| Merchant permissions | 6/8 granted | Orders/payments, refunds, payouts (scope), disputes, subscriptions, webhooks ✓ · **Invoicing ✗, Transaction Search ✗** (403 `NOT_AUTHORIZED`, debug_id `ca44b3d671dd3`) |
| Typed client vs real API | ✓ | GET webhooks, GET webhooks-event-types (205 types), GET disputes, POST catalogs/products, POST billing/plans; PayPal error bodies surfaced with debug_id (403, 404, 415, 422 all observed and reported, none masked) |
| Public URL | ✓ | cloudflared quick tunnel → localhost:3000 |
| Webhook registered via API | ✓ | `6LM98219SY592684V`, 26 explicit event types, no wildcard |
| Genuine sandbox events produced | ✓ | Product `PROD-3LC63319YS343453U`, plan `P-3C3205401W578402JNLANSRI`; product `PROD-6NV19771BE210063L`, plan `P-9XU672403U1005029NLANTOA` |
| Received + authenticity verified | ✓ | 4 real deliveries, all `SELF`-verified (CRC32 of raw bytes + PayPal cert): `WH-50074941UK138245D-7US85551M2130060L` (CATALOG.PRODUCT.CREATED), `WH-50074941UK138245D-04Y62451R9072400M` (BILLING.PLAN.CREATED), `WH-4HT70945PS3520705-1A510108WD236522D`, `WH-92A44771MF4158253-4TB11425E9741153S` |
| Persisted, provenance REAL_PAYPAL_SANDBOX | ✓ | `paypal_events`, raw signed bytes + transmission headers kept |
| Confirmed against PayPal before routing | ✓ | worker `GET /v1/notifications/webhooks-events/{id}` for each (debug_ids `f736057c149cd`, `f57061092c1a9`, `f786033d44f20`, `f1772707b3760`) |
| Processed exactly once | ✓ | PayPal's own signed delivery of `WH-92A4…41153S` replayed 3× through the public tunnel → HTTP 200 `duplicate` each time, deliveries = 4, **1** routing job, 3 `paypal.webhook.duplicate` audit records |
| Tampered delivery rejected | ✓ | Same PayPal signature headers, one price digit changed in body → HTTP 400, not stored, delivery count unchanged |
| Audit chain | ✓ | 14 records, verifies, head `0ddc3935…8d0b48` |

What did **not** work, and why (PayPal account limits, not code):

| Attempt | PayPal response | Meaning |
|---|---|---|
| Orders v2 with sandbox test card | 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` (debug_id `f157463b704d3`) | The linked sandbox merchant has no card processing |
| Payout $1.00 | 403 `PAYOUT_NOT_AVAILABLE` "You live in a country that is not allowed to send this payout" (debug_id `f32366303b5c6`) | The app is linked to an **India-registered** sandbox business account; India accounts cannot send Payouts → blocks Scenario C |
| `POST …/webhooks-events/{id}/resend` | 404 `INVALID_RESOURCE_ID` / 415 | Sandbox resend only applies to failed deliveries; replay of stored signed bytes used instead |

Nothing in Phase 2 is simulated. No simulator events were used.

## NEXT

Phase 3 — workflow DSL, graph editor, deterministic runtime (waiting for go-ahead after the Phase 2 checkpoint).
