# Settled PayPal Sandbox proof — 2026-10-11

One real payment through the whole PayFlow path, approved by the owner beforehand: exactly one payout, no retries, no database edits.

**REAL_PAYPAL_SANDBOX** · AI evidence: **CACHED_AI_ANALYSIS** (0 new model calls, $0)

```
Cloud Procurement Agent ──MCP──▶ PayFlow ──▶ authority: ALLOW (no person needed) ──▶ PayPal Payouts
        ◀── PAYMENT.PAYOUTS-ITEM.SUCCEEDED (signed webhook, verified, confirmed with PayPal) ◀── SUCCESS
        Intent Receipt: COMPLETED · Settled · integrity verified
```

| | |
|---|---|
| Agent | Cloud Procurement Agent (demo agent; permission to ask through *Cloud procurement* only) |
| Request | `PF-3YA8N6MA` · request id `settled-proof-aws-15-20261011` · **$15.00 USD** → AWS Demo `sb-mnylb53193692@personal.example.com` (a PayPal Sandbox personal account) · "EC2 GPU compute for model training" · invoice AWS-9301 |
| Workflow / authority | Cloud procurement v5 · authority *Cloud procurement* v6 (Acme Cloud + AWS, USD, ≤ $500 each, $5,000 a month, cloud infrastructure) |
| Decision | **ALLOW** — Identity ✓ Agent scope ✓ Supplier ✓ Currency ✓ Amount ✓ Budget ✓ Purpose ✓ Risk ✓ — no human approval needed |
| PayPal action | Payouts batch **`PNEA99DU4KEVW`**, item `KH6PMQMW9DAMJ`, transaction `9DK050923G4358331`, idempotency key `pf:748c83cf-c359-4c45-81b7-605c944aa28e:pay` |
| PayPal API status | batch **SUCCESS**, item **SUCCESS** (read-only `GET /v1/payments/payouts/PNEA99DU4KEVW`, debug id `ca48ec81658cb`) — `02-paypal-api-status.json` |
| Webhooks | `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` (`WH-8R969877296902614-88478847X4548494C`) and `PAYMENT.PAYOUTSBATCH.SUCCESS` (`WH-38D1422032378700B-3V371541CW375543P`) — signature self-verified, each stored once, confirmed with PayPal's API, routed by the worker |
| PayFlow status | **Settled** (`paypal_status: SUCCESS`, `confirmed_by_webhook: true`, `final: true`) — agent-visible state `COMPLETED` |
| Timeline (UTC) | 15:07:30 request · 15:07:31 authority ALLOW · 15:07:34 PayPal accepted (PENDING) · 15:07:58 PayPal completed · 15:08:19 webhook received · 15:08:58 receipt: settlement + final |
| Audit | records #994–#1019: request → run → AI evidence (cache) → authority decision → action prepared → PayPal result → budget committed → webhook confirms → receipt links. Chain intact. |

PayFlow called this *Submitted to PayPal* until PayPal's own confirmation arrived, and *Settled* only after it.

## Files

| File | Shows |
|---|---|
| `mcp/01-agent-request.json` | The agent's request and PayFlow's answer over MCP (credential redacted) |
| `02-paypal-api-status.json` | PayPal's own status for the batch and item |
| `mcp/03-agent-sees-final-state.json` | What the agent is told afterwards: `COMPLETED`, settlement `SETTLED` |
| `04-intent-receipt-settled.png`, `05-intent-receipt-full.png` | The Intent Receipt in plain words; the hashed receipt; the 5-link outcome chain |
| `06-authority-checks-allow.png`, `07-execution-full.png` | The run: every check passed → *Allowed automatically*; AI evidence beside PayFlow's own calculations |
| `08-paypal-events-signed-webhook.png` | The signed PayPal events |
| `09-audit-paypal-result.png`, `10-audit-request-and-receipt.png` | The audit trail for the PayPal batch and for the request |
| `11-executions-list.png` | Executions: *completed* with *PayPal: Settled* |

How it was reached: a temporary Cloudflare tunnel; the existing Sandbox webhook `9MJ408823R309725D` moved to it (same id, no duplicate); the request sent once with `pnpm agent:mcp call payflow_request_payment`. Nothing was edited by hand.
