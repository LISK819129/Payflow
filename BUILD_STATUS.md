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
| **3** | **Workflow DSL, validator, durable runtime, Flow Builder, Executions (2026-10-03)** | see Phase 3 evidence |
| **4** | **AI workflow compiler — mock-validated and real-model validated (2026-10-03)** | see Phase 4 evidence · `evidence/phase4/` |
| 1.5 | Local Postgres encoding bug: cluster had initialised as WIN1252, so any non-ASCII text failed to insert. Databases recreated as UTF8 (old ones kept as `*_win1252_old`), migrate now refuses non-UTF8, new clusters init with `--encoding=UTF8` | Regression test with non-ASCII audit text |

## IN PROGRESS

—

## BLOCKED / NEEDS USER ACTION

| Item | Needed from user | Blocks |
|---|---|---|
| PayPal Sandbox app | Credentials in `.env.local` ✓ | — |
| PayPal AI Toolkit plugin | Installed on the account 2026-10-03; loads in the next session. Its best-practices references were read directly from github.com/paypal/AI-Toolkit for Phase 2 | — |
| APIMatic Context Plugin | Installed 2026-10-03 as project skills in `.claude/skills/` (TypeScript set, pinned commit 6aa0571) because the installer needs the `claude` CLI, which this machine lacks. Loads next session. Free-subscription form still to be submitted by the user | — |
| AI provider | OpenAI `gpt-5.4-mini` configured; $5 total budget, $0.35 used | — |
| Public webhook URL | cloudflared 2026.9.3 downloaded (Authenticode: Cloudflare, Inc., valid) | — |
| PayPal sandbox merchant | Link the app to a **US** sandbox business account (current one is India-registered: payouts + card processing refused) and enable **Invoicing** + **Transaction Search** | Scenarios A, C, overdue reminder (Phase 5) |

## Phase 4 evidence

Full detail, screenshots and a database-generated manifest: [`evidence/phase4/README.md`](evidence/phase4/README.md), `evidence/phase4/manifest.json`.

| Item | Result |
|---|---|
| Architecture | Provider-neutral `AIProvider`; OpenAI (default) and Anthropic adapters; strict structured outputs; PayFlow re-parses every response; grounding check + Phase 3 validator decide; drafts only; activation always human |
| Mock tests (MOCK_TEST) | 10 scenario categories, malformed output, invented node types, unsafe edges, budget guard, provenance — part of 99/99 passing tests |
| Real model (REAL_OPENAI) | `gpt-5.4-mini`, **13 calls, $0.347525**, Phase 4 cap $1, ≈$4.65 of $5 remaining |
| Simple instruction | COMPILED after 1 repair → 7-node graph, grounded, valid, activatable |
| Full Nova instruction | Clarification ×3 (precise questions; receipts/audit report listed as unsupported); last two rounds truncated at 16k/24k output tokens → FAILED safely, nothing saved; no Nova draft |
| Ambiguous / bypass / impossible | Clarification / unsupported ("would move money with no policy gate or human approval") / unsupported — nothing saved |
| Prompt injection in invoice text | Compiled with the stated $300 limit and approval; injected `1000000` ignored and reported as untrusted data |
| NL edits | One-value edit = exactly one diff entry; precise exception edit adds a 2-node branch, unrelated nodes untouched, kept as draft v2 while v1 stays active |
| End-to-end (REAL_OPENAI + REAL_PAYPAL_SANDBOX) | AI-compiled v1 activated by owner → Sandbox capture `16J09094P99667628` ($2,750) → webhook `WH-2GU87192VK4570835-8ME497805N0158404` (SELF-verified) → worker → limit blocked → paused → owner approved → **COMPLETED** (run `6501f281-4c9d-4cee-9238-c9fee0299da5`); audit chain intact |
| Fixed during capture | Login limiter counted successful sign-ins (now failures only, tested); repair reasons were not persisted (now `ai_compilations.repairs` + `compileMeta.repairReasons`, tested); prompt hash recorded per draft; webhook registration now moves the single PayFlow webhook instead of creating duplicates |
| Open findings | AI boundary mismatch at exactly $2,500 (inclusive limit vs stated "under"); approved path ends at "Accepted automatically."; multi-automation instructions exhaust output tokens (proposal: split into separate workflows); stale Phase 3 demo flow also subscribes to captures |

## Phase 3 evidence

| Item | Verified by |
|---|---|
| Typed DSL: 22 node types (12 executable now, later-phase types draftable but not activatable), zod config per type | `tests/dsl.test.ts` |
| Condition language is data (typed AST, fixed interpreter); exact decimal money (BigInt), currency-aware comparison, `pct_diff`; missing data / type mismatch → error, never "false" | 7 expression tests incl. prototype-pollution and prompt-injection-as-data |
| Validator: one root trigger, no cycles/dead ends/unreachable nodes, one edge per port, refs only to nodes that run on every path first (dominators), **money/external nodes unreachable unless a policy `pass` or approval `approved` was taken**, AI output may not feed a money action | 7 validator tests |
| Versioning: DRAFT edited in place; editing an ACTIVE workflow creates a new draft; activation is human, validated for activation, superseding the old version with a field-level diff in the audit chain (`max.value 5000.00 → 4000.00`) | runtime test "keeps a running run on the version it started with" |
| Durable runtime: one node per transaction under a run row lock; steps + audit committed together; approvals and timers park the run; PAUSED/FROZEN suspend runs (except the run that froze it); freeze cascades to dependent workflows; runs idempotent on (version, trigger ref) | `tests/runtime.test.ts` — 13 tests incl. 3 concurrent workers on one run → no duplicate steps |
| PayPal event routing → matching ACTIVE workflows (optional trigger filter), frozen/paused workflows recorded as held | runtime routing test |
| Worker queues: paypal-event-route, run-advance, workflow-schedule, timer-sweep | worker log: run → WAITING_APPROVAL → COMPLETED |
| Flow Builder (React Flow): node library generated from the catalogue (later-phase nodes disabled with phase label), inspector, live client-side validation, save draft, activate, pause/resume/unfreeze, manual run (USER-PROVIDED) | Browser: added node → 3 live problems; seeded flow → Valid → Activate → "v1 is active" |
| Executions list + run view: path overlay (travelled edges in marker cyan), step timeline with explanations, approval panel | Browser: manual $6,850 run → waiting approval at "Amount differs materially" → Approve with note → completed; 5 travelled edges |
| AI | **No Anthropic API calls made** (Phase 4) |

Visual inspection of the canvas is pending: the preview pane was hidden during this session, so screenshots could not be taken; DOM checks were used instead.

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

Waiting for approval of the Phase 4 checkpoint before Phase 5 (PayPal action nodes).
