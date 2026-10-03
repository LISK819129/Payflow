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
| 1 | App shell, design tokens (light/dark), provenance badges, Dashboard / PayPal events / Audit pages | Browser check, no console errors |

## IN PROGRESS

—

## BLOCKED / NEEDS USER ACTION

| Item | Needed from user | Blocks |
|---|---|---|
| PayPal Sandbox app + accounts | Client ID/Secret in `.env.local`, three sandbox accounts (see README of this turn) | Phase 2 |
| PayPal AI Toolkit plugin for Claude Code | Run `/plugin install paypal@claude-plugins-official` in an interactive Claude Code session | PayPal integration work (Phase 2+) |
| APIMatic Context Plugin | Run `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview` | Phase 2+ (also prerequisite for the APIMatic prize) |
| AI provider key | Decide provider + add key | Phase 4 |
| Public webhook URL | Tunnel or early Render deploy — decided at Phase 2 | Phase 2 webhooks |

## NEXT

Phase 2 — real PayPal Sandbox: OAuth token cache, first real API call, webhook endpoint with signature verification, idempotent event persistence. Will not proceed past Phase 2 until a real sandbox webhook has been received and verified.

## Known limitations (tracked, not hidden)

- One PayPal app per deployment, bound to one workspace. Multi-merchant onboarding (Partner Referrals) is future work.
- Login rate limiter is in-process; fine for a single web instance.
