# Submission checklist — PayPal AI Hackathon 2026

Deadline: **November 12, 2026, 12:00 PM PT**. Judging: **December 1–15, 2026**.

The requirements below are the ones recorded from the official rules page on 2026-10-03 (video under three minutes; public GitHub repository with an open-source license and all source and instructions; demo access by hosted URL *or* complete setup instructions with test credentials; a text description; PayPal's developer platform central to the project, on Sandbox; an AI tool or model). **Read the live Devpost form before submitting** — anything it asks for that is not on this list was not in our notes.

| | Requirement | Status | Where |
|---|---|---|---|
| [ ] | Public GitHub repository | **You:** make it public (it is private today) | `docs/PUBLIC_RELEASE_CHECKLIST.md` |
| [x] | Recognized open-source license | Done — MIT, © 2026 Atul Krishna R. | `LICENSE` |
| [x] | Working source code | Done — 315 tests, lint, typecheck and production build pass | repository |
| [x] | Local setup instructions | Done | `README.md` → *Run it locally*; `docs/JUDGE_TESTING.md` |
| [ ] | Functional demo access | **You:** deploy to Render (≈ Nov 8–10). Local instructions exist as the fallback the rules allow, but they need the tester's own PayPal Sandbox and OpenAI keys — so the hosted site is what judges will really use | `docs/DEPLOYMENT.md` |
| [ ] | Video under 3 minutes | **You:** record and upload. Our notes say "under three minutes, showing the working project"; they do **not** record a required platform or visibility — check the form (YouTube, public or unlisted, is the usual ask) | `docs/DEMO_VIDEO.md` |
| [x] | Written project description | Ready to paste | `docs/DEVPOST_SUBMISSION.md` |
| [x] | PayPal technologies used | Ready to paste | `docs/DEVPOST_SUBMISSION.md` |
| [x] | AI technologies used | Ready to paste | `docs/DEVPOST_SUBMISSION.md` |
| [x] | Testing instructions | Ready — fill in the URL and password in the form | `docs/DEVPOST_SUBMISSION.md` → *Testing instructions* |
| [ ] | Judge credentials | **You:** `judge@payflow.demo` + the password you type into Render; put them in the Devpost form only | `docs/DEPLOYMENT.md` §14 |
| [ ] | Demo stays up through judging | **You:** keep the three Render resources running until judging ends (Dec 15; safest until winners are announced, ~Dec 21) — about $28 of the $50 credit | `docs/DEPLOYMENT.md` |

## Order of work

1. `docs/PUBLIC_RELEASE_CHECKLIST.md` → make the repository public.
2. Record the video (`docs/DEMO_VIDEO.md`) — locally, now; it does not need the hosted site.
3. Around Nov 8–10: deploy (`docs/DEPLOYMENT.md` §2–§12), then one fresh settled payment on the hosted site (§13).
4. Paste `docs/DEVPOST_SUBMISSION.md` into Devpost; add the repository link, the video link, the hosted URL and the judge login (§14). Submit before Nov 12, 12:00 PM PT.
5. Dec 1–15: keep the site up. Once or twice, check `pnpm deploy:verify`, and re-create the waiting $650 approval if you want judges to find one (it expires after 24 hours).

## Not recorded in our notes — confirm on the form

- Whether the video must be public or may be unlisted, and on which platform.
- Whether the form has a judges-only field for credentials. If it does not, a Sandbox-only demo login with capped AI spend is acceptable to share, and `pnpm deploy:judge-password` changes it afterwards.
- Any team, eligibility or category questions.
