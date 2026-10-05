# PayFlow security notes

A focused pre-deployment review (Phase 10, 2026-10-05). This is not a certification or a penetration test; it records what was checked, what was fixed and what remains.

## Model

- **PayPal is Sandbox only.** `PAYPAL_ENV=live` refuses to boot.
- **Nothing that reasons holds credentials.** The OpenAI key, PayPal client secret, owner sessions and database credentials live only in the server environment. AI agents authenticate with their own scoped, revocable bearer credential and reach PayFlow's MCP server — never PayPal.
- **Money moves only through the authority engine.** Every PayPal write passes policy gates, delegated authority (row-locked check and reservation), optional human approval, an idempotency key, and — for agent requests — a check that the action is exactly what the agent's Intent Receipt says. Test Run and Observe Mode cannot obtain a PayPal write capability (four layers).
- **Everything is audited** in a per-workspace hash chain.

## Checked

| Area | Finding |
|---|---|
| Sessions | DB-backed, hashed session ids; cookie `HttpOnly`, `SameSite=Lax`, `Secure` in production. |
| CSRF | State changes are Next.js Server Actions (origin-checked by Next) or bearer-authenticated JSON (MCP) — no cookie-authenticated JSON endpoints. |
| Login | scrypt passwords; failed attempts throttled per IP+account and (new) per account. |
| Agent tokens | 32-byte random secret, SHA-256 stored, constant-time compare, shown once, rotatable, revocable, expiring; status re-read on every call. |
| Authorization | Owner-only: agents, authority, demo restore. Owner/approver: workflows, activation, approvals, tests. `decideApproval` itself refuses non-owners/approvers (an agent can never approve). |
| Webhooks | Signature self-verified (cert URL restricted to `*.paypal.com` over https, redirects refused) with postback fallback; unique per PayPal event id; confirmed with PayPal's API before confirming anything; processed async. |
| SSRF | The only outbound fetch with an input-derived URL is the PayPal signing certificate, restricted as above. |
| Prompt/document input | Untrusted text is nonce-fenced for the model and scanned for injected instructions by code; AI output is evidence for the policy, never permission. |
| SQL | Drizzle query builder / parameterised `sql` templates; no string-built SQL from input. |
| XSS | React escaping; no `dangerouslySetInnerHTML`; agent and invoice text rendered as text. |
| Request size | MCP 64 KB, webhook 512 KB, Test Run input 64 KB, evidence documents 8 KB each. |
| Rate limits | Login, MCP (failed auth per IP; calls and submissions per agent), AI drafting (per person / workspace), Test Runs (per person). Plus the shared, DB-backed AI money caps: lifetime, optional phase, and (new) rolling 24 h. |
| Health | Liveness and readiness return states only — no hosts, URLs, ids, keys or error text. |
| Errors | User-facing errors explain what happened and whether money moved; no stack traces or provider payloads. MCP auth errors never echo the credential. |
| Logging | No credentials, tokens or keys logged; webhook/MCP logs carry reasons, not payloads. |
| Production config | Boot refuses: local or reused local-dev database credentials, short DB passwords, non-https APP_URL, placeholder session secrets, simulator events on, half-configured PayPal, a public demo with AI and no daily cap. |

## Fixed in Phase 10

1. **Client IP spoofing.** Rate limits keyed on the *first* `X-Forwarded-For` entry, which the caller controls; behind a proxy that allows rotating fake IPs. Now the entry `TRUSTED_PROXY_HOPS` from the end is used (login, MCP, webhook).
2. **Login throttling bypass** via rotating IPs: added a per-account limit independent of IP.
3. **Viewers could create workflows and save drafts** (server actions lacked the role check the UI implied). Now owner/approver only.
4. **No limit on AI drafting or Test Runs** — a visitor could spend the OpenAI balance. Per-person/workspace limits and a rolling daily cap added.
5. **Security headers**: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; `X-Powered-By` removed.
6. **AI analysis lease race** (correctness): a failed first attempt released its lease to `now()` on a millisecond column, which could round up so the immediate retry waited ~45 s on its own lease. Now released to `null`.

## Residual risks

- Rate limits are per process: correct for the single judging instance; not for horizontal scaling.
- Agent credentials are bearer tokens (not OAuth/mTLS); anyone holding one can act as that agent within its scope until it is revoked or expires.
- No content-security policy beyond `frame-ancestors` (a full CSP would need nonce plumbing through Next.js).
- The seeded judge owner is a shared login; anyone with it can approve demo payments (Sandbox only).
- Session cookies are `SameSite=Lax`; a top-level navigation from another site carries them (Server Actions still check origin).
- `.env.example` documents a local-development database password by design; production refuses to use it.
