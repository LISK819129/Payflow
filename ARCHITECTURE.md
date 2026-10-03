# PayFlow Architecture

> AI interprets. Code enforces. Humans authorize. PayPal executes.

## 1. Shape of the system

```
                 ┌───────────────────────── Next.js app (Render web service) ─────────────────────────┐
 Browser ───────▶│ UI (React, XYFlow canvas)   API route handlers (thin: auth → call a server module) │
 External agent ▶│ PayFlow MCP endpoint /api/mcp   Agent REST /api/agent/*                             │
 PayPal ────────▶│ POST /api/webhooks/paypal  → verify → persist (unique event id) → enqueue          │
                 └──────────────────────────────────────┬─────────────────────────────────────────────┘
                                                        │ Postgres (single source of truth)
                 ┌──────────────────────────────────────▼─────────────────────────────────────────────┐
                 │ Worker (Render background worker): pg-boss queues                                  │
                 │  webhook.route  → match event to ACTIVE workflow versions → start runs             │
                 │  run.step       → deterministic interpreter advances one run                       │
                 │  run.timer      → delay / due-date nodes wake runs                                 │
                 │  schedule.tick  → schedule triggers                                                │
                 │  sim.run        → simulator jobs                                                   │
                 └───────┬──────────────────────┬──────────────────────────┬──────────────────────────┘
                         │                      │                          │
                  PayPal adapter           AI adapter               Retrieval adapter
              (REST + server SDK)      (AIProvider interface)     (Postgres default, Elastic optional)
```

All financial logic lives in `src/server/**`. Route handlers only authenticate, parse, and call a module. Nothing in `src/server` is importable by client components (`server-only` guard).

## 2. Modules

| Module | Path | Responsibility |
|---|---|---|
| config | `src/server/config` | zod-validated environment; reports which integrations are configured so the UI can say "setup required" instead of faking |
| db | `src/server/db` | Drizzle schema + migrations, transaction helper |
| paypal | `src/server/paypal` | OAuth token cache (refresh before expiry, single-flight), REST client (`PayPal-Request-Id`, debug-id capture, typed errors), Invoicing/Payouts/Disputes/Webhooks clients, server SDK wrapper |
| webhooks | `src/server/webhooks` | Raw-body signature verification, idempotent persistence, enqueue |
| workflow/dsl | `src/server/workflow/dsl` | Zod schema for workflows, node catalogue, structural validation (graph is a DAG except explicit loops, every path ends in a terminal, money nodes are dominated by policy nodes) |
| workflow/compiler | `src/server/workflow/compiler` | NL → DSL via AI, validate, repair loop (bounded), NL edits → JSON-patch ops against the DSL, diff for review |
| workflow/runtime | `src/server/workflow/runtime` | Durable interpreter. One step per job; every step's input/output persisted; resumable after crash/approval/timer |
| workflow/nodes | `src/server/workflow/nodes` | One executor per node type; the UI node library is generated from this registry, so no UI node exists without a backend |
| policy | `src/server/policy` | Budgets (ledger with row locks), frequency, counterparty, currency, category rules — pure functions + locked reads |
| approvals | `src/server/approvals` | Approval requests, decisions, resume |
| agents | `src/server/agents` | Ephemeral capabilities, token hashing, atomic use-counting, agent request handling, PayFlow MCP tools |
| simulation | `src/server/simulation` | Runs the real runtime with a stub PayPal executor and labelled fixtures |
| ai | `src/server/ai` | `AIProvider` interface + Anthropic implementation, prompts, output schemas |
| retrieval | `src/server/retrieval` | `ContextRetriever` interface: counterparty history, invoice candidates, prior anomalies/disputes |
| audit | `src/server/audit` | Append-only, hash-chained audit records |
| jobs | `src/server/jobs` | pg-boss setup, queue names, typed payloads |

## 3. Workflow DSL (summary)

A workflow version is immutable JSON validated by zod:

```
Workflow { id, ownerId, name, state }
WorkflowVersion { id, workflowId, version, graph, policies, provenance, createdBy, createdAt, activatedBy?, activatedAt? }
Graph { trigger: TriggerNode, nodes: Node[], edges: Edge[] }
Edge { from, to, when?: "true" | "false" | "approved" | "rejected" | "pass" | "block" | "error" | <label> }
```

Node families: Trigger (manual, schedule, paypal_event, agent_request), PayPal action (create/send/remind invoice, create order, capture, refund, payout, fetch order/capture/invoice/dispute), AI (transaction analysis, behaviour analysis, invoice match, purpose classification, explanation), Control (condition, approval, budget limit, frequency limit, counterparty/currency/category restriction, delay, freeze, run-once, terminal).

**Conditions are data, not code.** A condition is a small typed expression tree (`{op:"lte", left:{ref:"event.amount"}, right:{const:400}}`) evaluated by a fixed interpreter. There is no `eval`, no generated code, no template strings executed.

**AI output never drives a money edge directly.** AI nodes write a typed verdict (`risk: LOW|MEDIUM|HIGH`, `category`, `matchedInvoiceId`, `confidence`, `evidence[]`). Only Condition / Policy nodes route on those fields, and the validator refuses any graph where a PayPal action is reachable from an AI node without passing a policy node.

States: `DRAFT → VALIDATING → (SIMULATING) → AWAITING_APPROVAL → ACTIVE ⇄ PAUSED`, `ACTIVE → FROZEN` (dispute/refund/manual), terminal `COMPLETED | EXPIRED | FAILED`. AI-generated workflows always land in `DRAFT`; activation is a human action recorded in the audit chain.

Editing an ACTIVE workflow creates a new version. Runs are pinned to the version they started on, so editing mid-run cannot change a run in flight. A change that raises a limit, adds a counterparty, or adds a money action requires re-activation.

## 4. Runtime guarantees

| Guarantee | Mechanism |
|---|---|
| A webhook delivered twice executes once | `paypal_events.event_id` unique; insert-or-ignore; routing keyed on event id |
| A PayPal action retried after a crash is not repeated | `PayPal-Request-Id` / `sender_batch_id` = hash(runId, nodeId, attempt-scope); `action_executions` row written PREPARED before the call, EXECUTED after |
| Two concurrent spends cannot both fit under one budget | Budget row `SELECT … FOR UPDATE` inside the transaction that reserves the spend |
| A capability is used at most N times | `UPDATE … SET uses = uses + 1 WHERE id = $1 AND uses < max_uses AND expires_at > now() AND revoked_at IS NULL RETURNING *` |
| Uncertainty stops money | AI provider error / schema-invalid output / retrieval failure → node returns `error`; default edge for `error` on any path to money is a pause + approval, never a pass |
| Webhook payloads aren't trusted | Before any decision, the referenced resource (capture, invoice, dispute) is re-fetched from PayPal |
| History is reconstructable | Every step writes an audit record `{seq, prevHash, hash, actor, kind, payload}`; the chain is verifiable from the Audit page |

## 5. Data provenance

Every displayed money record carries one of: `REAL_PAYPAL_SANDBOX`, `SIMULATED`, `AI_GENERATED`, `USER_PROVIDED`. Simulator fixtures are stored in a separate table and can never be routed to a real workflow trigger.

## 6. Security model

- PayPal and AI secrets exist only in server env; the browser never receives a token.
- Session auth (scrypt password hash, httpOnly SameSite=Lax cookie, rotated session ids); every query is scoped by workspace.
- Agent capability tokens: 32 random bytes, shown once, stored as SHA-256.
- Webhook cert URLs restricted to PayPal hosts; raw body verified before parsing.
- Prompt-injection posture: financial metadata (invoice notes, item descriptions, agent "purpose" text) is passed to models as quoted data inside a delimited block, never as instructions, and no model output can grant itself permission — permissions are only read from the stored capability/policy.
- Rate limits on login, agent endpoints, and the webhook endpoint.
- Logs pass through a redactor (tokens, secrets, emails partially masked).

## 7. AI usage

`AIProvider` exposes `compileWorkflow`, `patchWorkflow`, `analyzeTransaction`, `analyzeBehavior`, `matchInvoice`, `classifyPurpose`, `explainDecision`, `analyzeSimulation`. Each returns a zod-validated object; invalid output triggers a bounded repair attempt, then fails safe. Model per task is configurable (strong model for compile/patch/simulation analysis, small fast model for classification). Default provider: Anthropic Claude; the interface allows another provider without touching the runtime.

## 8. Infrastructure

| Concern | Local dev | Deployed (Render) |
|---|---|---|
| Postgres | `embedded-postgres` (real PostgreSQL binaries, data in `.data/pg`) | Render Postgres |
| Web | `next dev` | Render web service |
| Jobs / timers / schedules | worker process (`tsx src/worker`) on pg-boss | Render background worker on pg-boss |
| Simulator fan-out | in-process | Render Workflows task per scenario batch — **evaluated in Phase 8/11**: Workflows has no native scheduling or sleep, so it does not replace pg-boss for timers/approvals, but parallel simulation is a genuine fit |
| Public webhook URL | tunnel (decided in Phase 2) | Render URL |
| Retrieval | Postgres queries | Postgres, or Elastic if claimed (see §9) |

pg-boss over Render Workflows for the core runtime: approvals can wait days, reminders fire "3 days after due date", schedules are cron — all native in pg-boss, none native in Workflows.

## 9. Sponsor technology decisions

| Sponsor | Decision | Why |
|---|---|---|
| Render | Deploy target (web + worker + Postgres); Workflows for simulation fan-out if it measurably helps | Has a prize track ("Best Use of Render"); $50 participant credit |
| APIMatic | Context Plugin at build time; the runtime uses the APIMatic-generated `@paypal/paypal-server-sdk` | Has a prize track; genuine fit, the plugin documents the exact SDK we use |
| AG Grid | Candidate for Executions / Audit / Ledger grids (AG Studio, 45-day trial) | Largest sponsor prize ($5k); only if it improves those pages — decided in Phase 6 |
| Elastic | Retrieval adapter behind `ContextRetriever`; Postgres implementation first | **No Elastic prize track** in the published prize list, so it is only worth adding if retrieval quality needs it |
| KERNEL | Optional external-agent browser demo after core works | No prize track; $50 credit |
| Bryntum | Not planned (possible: overdue-invoice / approval timeline) | Trial licence only |

A project can win at most one sponsor prize, so we optimise for one (AG Grid or Render or APIMatic) rather than sponsor stuffing.
