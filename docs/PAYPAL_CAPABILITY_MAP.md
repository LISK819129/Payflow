# PayPal Capability Map

Researched 2026-10-03 against current official sources (listed at the bottom).
Status legend: **PLANNED** · **IN PROGRESS** · **DONE (verified against Sandbox)** · **BLOCKED**.

Nothing in this table is marked DONE until a real Sandbox call has succeeded and the evidence is recorded in `BUILD_STATUS.md`.

## 1. What PayPal already provides vs. what PayFlow adds

| Layer | Provided by PayPal | Added by PayFlow |
|---|---|---|
| Money movement | Orders v2, Payments v2 (capture/refund/void), Payouts v1, Invoicing v2, Subscriptions v1 | Decides *whether* and *when* a call is allowed; never calls PayPal without passing policy |
| Events | Webhooks v1 (signed, retried up to 25× over 3 days) | Verification, idempotent ingest, routing events to versioned workflows |
| AI access | Agent Toolkit (`@paypal/agent-toolkit` 1.11.0), PayPal MCP server (local `@paypal/mcp` 1.8.1, remote `mcp.sandbox.paypal.com`), AI Toolkit plugin for coding agents | A permission boundary in front of those: scoped, expiring, single-use capabilities instead of handing an agent a PayPal token |
| Policy | Account-level risk and limits | Per-workflow budgets, counterparty/currency/category restrictions, frequency limits, human approval gates |
| Reasoning | — | Natural language → typed workflow graph; transaction / behaviour / invoice-match / purpose analysis as nodes whose output feeds deterministic rules |
| Pre-flight | — | Simulator that runs the real runtime against historical + labelled synthetic events with every PayPal action stubbed |
| Audit | Transaction records, debug IDs | Hash-chained, append-only trace of every decision, rule, approval and PayPal response |

**The test the product must pass:** give an agent PayPal MCP directly and it can pay anything its token allows, with no memory of budgets, no proof of purpose, no approval, no freeze on dispute and no reconstruction of why. PayFlow exists to make that impossible.

## 2. Feature → capability map

| PayFlow feature | PayPal capability | API / tool used | Sandbox | Auth | Webhook events | Limitations / notes | Status |
|---|---|---|---|---|---|---|---|
| Server auth to PayPal | OAuth 2.0 client credentials | `POST /v1/oauth2/token` | Yes | Client ID + Secret (Basic) | — | Token TTL ~8–9 h; cached server-side, refreshed before expiry, single-flight | **DONE** (verified 2026-10-03) |
| Client invoicing (Nova Labs) | Invoicing v2 | `POST /v2/invoicing/invoices`, `POST …/{id}/send`, `GET …/{id}`, `POST /v2/invoicing/search-invoices` | Yes | Bearer | `INVOICING.INVOICE.CREATED`, `.PAID`, `.CANCELLED`, `.UPDATED`, `.REFUNDED` | Not in the official server SDK → own typed REST client. Payment happens when the sandbox *personal* account pays the invoice link in a browser; for tests the merchant records an external payment (`POST …/{id}/payments`), which sends a real `INVOICING.INVOICE.PAID` | **DONE** Phase 5: `INV2-XKNS-YUUN-4XJY-Q328`, `INV2-3REM-EZJK-GY57-2WXL` sent, paid, reconciled |
| Overdue reminder (approval-gated) | Invoicing v2 reminder | `POST /v2/invoicing/invoices/{id}/remind` | Yes | Bearer | — | PayPal answers 204 with no body, so the invoice is re-read afterwards and its real status recorded | **DONE** Phase 5 (approval-gated reminder on `INV2-XKNS-YUUN-4XJY-Q328`) |
| Client payment trigger (Scenario A/B) | Payments v2 capture events | Webhook + `GET /v2/payments/captures/{id}` (SDK `paymentsController.getCapturedPayment`) | Yes | Bearer | `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED` | Every event is confirmed with `GET /v1/notifications/webhooks-events/{id}` before routing | **DONE** Phase 4 (capture `16J09094P99667628`) |
| Accept a payment (checkout link for a client) | Orders v2 | SDK `ordersController.createOrder / getOrder / captureOrder` | Yes | Bearer | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` | Buyer approval needs the sandbox buyer to log in via the `payer-action` link (`pnpm paypal:sandbox:order`). Capture re-reads the order first and refuses ORDER_ALREADY_CAPTURED / AMOUNT_MISMATCH | **PARTIAL** Phase 5: capture node live; three real refusals verified; success path waits on a buyer approval |
| Refund (reject-anomaly path, Scenario F) | Payments v2 refund | SDK `paymentsController.refundCapturedPayment` | Yes | Bearer + `PayPal-Request-Id` | `PAYMENT.CAPTURE.REFUNDED` | Idempotent via `PayPal-Request-Id` = `pf:<run>:<node>`; crash replay returned the same refund (verified on Sandbox) | **DONE** Phase 5 (`9CL93909WG926700C`, `70387968X56817604`, `3B5520949P604025P`) |
| Supplier payment by procurement agent (Scenario C) | Payouts v1 | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{batch_id}` | Yes (US Sandbox merchant; the retired India merchant got 403 `PAYOUT_NOT_AVAILABLE`) | Bearer + unique `sender_batch_id` | `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED/FAILED/UNCLAIMED` | Not in server SDK → own client. `sender_batch_id` = idempotency key; a lost reply is recovered from PayPal's duplicate-batch refusal (verified) | **DONE** Phase 5 (`2DSJUHUB3A8CN`, `SWKXBFQR2EWXY`, `UM2QM3S7JCSDC`; example.com receivers → UNCLAIMED) |
| Supplier invoices ("payables") | — (PayPal invoices are seller-issued) | PayFlow `payables` table | n/a | n/a | — | Bills received from suppliers are **USER-PROVIDED** records. Stretch: a second sandbox app issues a real PayPal invoice as the supplier | PLANNED |
| Dispute trigger + freeze (Scenario F) | Disputes v1 | `GET /v1/customer/disputes/{id}`, list | Yes (created by sandbox buyer in the sandbox Resolution Center) | Bearer | `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED` | Sandbox dispute creation is manual and occasionally slow; refund event is the reliable fallback trigger for the same freeze path | PLANNED |
| Subscription triggers | Subscriptions v1 + Catalog products | SDK `subscriptionsController.*`; `POST /v1/catalogs/products`, `POST /v1/billing/plans` | Yes | Bearer | `CATALOG.PRODUCT.CREATED`, `BILLING.PLAN.CREATED`, `BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED` | Product + plan creation verified with real webhooks; trigger node in Phase 3+ | IN PROGRESS |
| Historical context | Transaction Search v1 | SDK `transactionSearchController.searchTransactions` | Yes, feature must be enabled on app | Bearer | — | Sandbox data can lag up to ~3 h; used for back-fill, while the live ledger is built from webhooks + API reads | **DONE** Phase 5 (`paypal.transaction_search` node, 6 rows over 7 days) |
| Webhook verification | Webhooks v1 | Self-verification (SHA256withRSA over `transmissionId|time|webhookId|crc32(rawBody)`, cert from `paypal-cert-url` restricted to PayPal hosts) with postback `POST /v1/notifications/verify-webhook-signature` as fallback | Yes | Bearer for postback | all | Raw body must be read before any JSON parse. Simulator events use webhook id `WEBHOOK_ID` and **cannot** be postback-verified → stored with `SIMULATED` provenance, accepted only when `PAYPAL_ALLOW_SIMULATOR_EVENTS=true` | **DONE** (real deliveries self-verified 2026-10-03) |
| Webhook registration | Webhooks v1 | `POST/GET/PATCH /v1/notifications/webhooks` | Yes | Bearer | — | `pnpm paypal:webhook:register <url>`; needs a public HTTPS URL | **DONE** (US app: `9MJ408823R309725D`, re-pointed to each new tunnel) |
| Event replay / redelivery | Webhooks v1 | `POST /v1/notifications/webhooks-events/{id}/resend` | Sandbox: 404 for successfully delivered events | Bearer | — | Idempotency proven instead by replaying PayPal's stored signed bytes; `GET …/webhooks-events/{id}` used to confirm every event before routing | **DONE** (alternative) |
| External agent access | PayPal MCP / Agent Toolkit | **Not exposed raw.** PayFlow exposes its own MCP server with capability-scoped tools | Yes | PayFlow capability token | — | See §3 | PLANNED |

## 3. REST vs. Agent Toolkit vs. PayPal MCP — decision

| Use | Choice | Reason |
|---|---|---|
| Runtime financial actions (capture, refund, payout, invoice send/remind) | **REST** — official `@paypal/paypal-server-sdk` 2.5.0 (APIMatic-generated) for Orders/Payments/Subscriptions/Transaction Search; own typed client for Invoicing, Payouts, Disputes, Webhooks (not in the SDK) | Every call must be explicit, idempotent (`PayPal-Request-Id`), typed and auditable. An LLM tool-calling loop is the wrong shape for executing money movement |
| Coding-time API correctness | **PayPal AI Toolkit plugin** for Claude Code + **APIMatic Context Plugin** (covers the same server SDK) | Integration code is written from current PayPal context, not model memory |
| Read-only context for AI analysis nodes | **Agent Toolkit**, allow-list `invoices.list/search`, `transactions.list`, `disputes.list/get` only | Lets an analysis node fetch evidence through PayPal's own agent tooling, but with write actions not even constructed. Evaluated in Phase 7; dropped if it adds nothing over the REST reads |
| External agents (ProcurementBot) | **PayFlow MCP server**, not PayPal's | The agent gets `request_payment`, `get_capability`, `list_payables` — each call checked against a scoped, expiring capability, then executed by the runtime via REST. The agent never holds a PayPal credential |

Note: `@paypal/agent-toolkit` 1.11.0 depends on `ai@^4`. PayFlow's AI layer does not use the Vercel AI SDK, so this does not conflict, but its tool objects are only consumed inside the retrieval adapter.

## 4. Sandbox setup PayFlow needs

| Resource | Purpose |
|---|---|
| Sandbox REST app (Developer Dashboard → Apps & Credentials → Sandbox) | Client ID / Secret for PixelForge (the merchant) |
| Sandbox **business** account `PixelForge` | The merchant that owns the app; sends invoices, receives payments, sends payouts |
| Sandbox **personal** account `Nova Labs` | The client who pays invoices / orders in the sandbox browser flow |
| Sandbox **business** account `Acme Cloud` | Supplier receiving payouts |
| App features enabled | Invoicing, Payouts, Transaction Search, Disputes (check in app settings) |
| Webhook on the app | Public HTTPS URL → `/api/webhooks/paypal`; event types listed in §2; returns the Webhook ID used for verification |

## Sources

- [PayPal AI Toolkit (GitHub)](https://github.com/paypal/AI-Toolkit) — Claude Code plugin `paypal@claude-plugins-official`, sandbox MCP over SSE, token expiry ~8 h
- [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit) — `@paypal/agent-toolkit` actions list
- [PayPal MCP server](https://developer.paypal.com/ai-tools/mcp-server.md) — `https://mcp.sandbox.paypal.com` (`/sse`, `/http`), local `npx @paypal/mcp --tools=all`
- [Webhooks](https://developer.paypal.com/api/rest/webhooks/rest/) — self-verification, postback endpoint, 25 retries / 3 days, simulator limitation
- [Payouts v1](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/)
- `@paypal/paypal-server-sdk` 2.5.0 (npm, inspected locally): controllers = Orders, Payments, Subscriptions, TransactionSearch, Vault, OAuth
- [APIMatic Context Plugin for the PayPal Server SDK](https://github.com/paypaldev/server-sdk-context-plugin-preview) — preview, hackathon-only
