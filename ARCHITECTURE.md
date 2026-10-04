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

## 10. Compiler: known limit and the decomposition seam (Phase 4.1)

Real-model testing showed that one paragraph can describe several automations (the Nova Labs instruction is really client-payment handling, an overdue-invoice reminder and a procurement-agent policy, with interlocking later-phase requirements). Compiling it as one graph made `gpt-5.4-mini` either ask design questions (correct) or exhaust its output budget (16k and 24k tokens, safely rejected as TRUNCATED). Raising the limit is not the fix.

Planned (Phase 8 or later): a **plan stage** before compilation.

```
instruction → AIProvider.planInstruction() → Plan { automations: [{ title, intent, dependsOn }] }
            → person reviews the plan ("I found 3 automations … [Review plan]")
            → compileInstruction() once per automation (each small, cacheable, independently validated)
            → workflows linked through `workflows.dependsOn` (freeze cascades already use it)
```

The seam already exists: `compileInstruction` takes one instruction and produces one draft; `dependsOn` links workflows; the envelope is provider-neutral. Adding `planInstruction` to `AIProvider` and a `PLAN` outcome is additive — no change to the validator, runtime or existing compile path.

Deterministic post-compile passes (Phase 4.1), in order: structural validation → **boundary review** (exact amounts land on the side the instruction states: "under $X" puts X with the larger amounts, "up to $X" with the smaller; unanimous instructions are corrected and reported, contradictory ones become questions) → **grounding** → activation readiness. Edits additionally run **label refresh** (a changed node's own text follows its new values; other nodes still quoting the old value are flagged). Run outcome text is derived from the executed path, never from an end node's authored copy.

## 11. PayPal actions: the execution boundary (Phase 5)

Every node that touches PayPal goes through one path. Nothing else in the codebase calls a PayPal write endpoint.

```
runtime step ──► prepareIntent ──► ActionIntent ──► gatewayFor(intent) ──► ActionGateway ──► PayPal
 (in run tx)     (fail closed)     (fully resolved)   (single routing point)  DirectPayPalGateway today
```

- **`prepareIntent`** (`src/server/actions/prepare.ts`) resolves the node's references against the run and refuses — before any network call — when the amount is missing, not an exact decimal with at most two places, zero or negative; the currency is not an ISO code; an email or PayPal id is malformed; or no policy gate passed and no approval was granted on *this run's executed path* (`NO_AUTHORIZATION`). The validator already guarantees a gate precedes every money node statically; this re-checks what actually happened.
- **`ActionIntent`** is plain data: kind, idempotency key, exact amount and currency, counterparty, target, the gates that authorised it, provenance. AI output is never an input to it — AI nodes cannot feed money nodes (validator rule `ai_feeds_money`).
- **Two-phase execution** (`src/server/actions/execute.ts`). The intent is stored `PREPARED` in the same transaction as the run step. The external call happens outside any transaction after an atomic claim (`PREPARED → SUBMITTING`, attempts + 1, 90 s lease). The reply is persisted in its own transaction. A crashed worker's lease expires and the next one re-claims it.
- **Idempotency key** `pf:<runId>:<nodeId>` is sent as `PayPal-Request-Id` (and as the payout `sender_batch_id`), so any re-send of the same action is the same request to PayPal. Verified on real Sandbox by rewinding a completed action to "reply lost" and letting recovery re-send it: the refund came back with the same id and the order still had one refund for it; the payout was refused by PayPal as a duplicate batch, and PayFlow adopted the linked batch only after checking that its `sender_batch_id`, receiver and amount are its own (`evidence/phase5/idempotency/`).
- **Fail closed on ambiguity.** 4xx is PayPal's answer and is final (`FAILED`, PayPal's specific `issue` and `debug_id` kept). 429/5xx/network errors are retried with the same key; after 3 attempts with no definitive answer the action is `UNKNOWN` and the run goes to review — it is never assumed to have failed or succeeded.
- **Multi-step actions checkpoint.** An invoice is created, its id checkpointed, then sent; a replay sends the checkpointed invoice instead of creating a second one. An order capture re-reads the order first and refuses a different amount or an order already captured (on a retry, an already-captured order is re-captured with the same request id so PayPal replays its original answer instead of PayFlow reporting a false failure).
- **Webhooks close the loop.** A PayPal event confirmed against PayPal's event store (`GET /v1/notifications/webhooks-events/{id}`) is matched to the action by the PayPal ids it names; the first match is the confirmation, later ones update the status PayPal reports (e.g. a payout item going `UNCLAIMED`). An event that arrives before PayFlow records the reply is bound when the action succeeds. Simulated events never confirm real actions.
- **Duplicate starts.** PayPal-event runs are unique per (version, event id); manual runs carry a per-dialog submission key, so a double click or replayed form post resolves to the same run (verified: two POSTs, one run, one payout).

### GatePal seam

`gatewayFor(intent)` (`src/server/actions/paypal-gateway.ts`) is the only place that chooses who executes an intent. Today every kind maps to `DirectPayPalGateway` (`PayFlow → PayPal`). A future GatePal gateway implements the same `ActionGateway` interface and is added to the `routed` table for the kinds it protects (`PayFlow → GatePal → PayPal`). The intent already carries what such a layer needs to authorise independently — exact amount, counterparty, target, the gate evidence and the idempotency key — and the runtime, audit and UI do not change. GatePal is not built.

### Operational note

Workers must run the same code version as the web app. A stale worker from an earlier session once claimed a Phase 5 run and refused the refund node as "cannot run yet" — fail-closed, nothing was sent — before it was stopped (`evidence/phase5/incident-stale-worker/`). Restart the worker after every deploy.

## 12. Financial authority (Phase 6)

The question this layer answers: *even if a workflow (or an AI) wants this financial action, is it actually authorized?*

```
action node ──► prepareIntent ──► authorityProvider().authorize ──► ALLOW ──► prepareExecution ──► runAction ──► PayPal
 (fail closed)                     CHECK + RESERVE, one tx           REVIEW ──► approval (Approve once / Reject)
                                                                     DENY ────► run BLOCKED, PayPal not contacted
```

**Authority** (`authorities`) = WHO (workflows) may do WHAT (PayPal action kinds), to WHOM (allowlist or "anyone not denied", plus a deny list), for HOW MUCH (per transaction; budget per calendar day/week/month, UTC), HOW OFTEN (count per hour/day/week/month), UNTIL WHEN (valid-from / expires). Currencies are explicit; limits are in the first currency and a request in another currency is denied rather than converted. Every create, edit, suspend, resume and revoke is an audited act by an owner and bumps the version; decisions record the version they were made under.

**Rules, failing closed.** Deny: authority not active, outside its validity window, action not permitted, counterparty denied, currency not permitted, a money action without an amount. Review (a person decides): no authority covers the action, more than one covers it and not all allow, counterparty not on the allowlist, per-transaction limit exceeded, budget or frequency exceeded, ledger state unreadable (lock timeout). Overlapping authorities must *all* allow. A person's approval can turn a REVIEW into an allow for that one request (fingerprinted: kind, amount, counterparty, target, run, node); it can never override a DENY, and approving never changes an authority — there is no "always allow".

**CHECK → RESERVE → EXECUTE → COMMIT / RELEASE.** `authorize` locks every matching authority row `FOR UPDATE` (in id order), reads committed + reserved usage for the period, evaluates, writes the decision and — only if allowed — the reservation, all in the action node's step transaction. A concurrent request for the same budget waits on the lock and then sees the reservation, so two requests can never both be granted the last of a budget (proved by tests that fail when the lock is removed). The execution is then sent outside the transaction (Phase 5). PayPal success → COMMIT; PayPal's definitive refusal → RELEASE; no definitive answer → the reservation is HELD and keeps counting. Recovery after a lost reply re-uses the existing execution, which already carries its decision, so it is never re-authorized or re-reserved.

**Just before sending,** the authority is re-checked: suspended/revoked/expired since the decision → if nothing was ever sent, the action is cancelled and the reservation released; if an attempt may already have reached PayPal, the outcome is UNKNOWN and the reservation held (never re-sent). A paused or frozen workflow defers the send and suspends the run.

**Workflow-level `policy.budget` / `policy.frequency` nodes** use the same ledger with an advisory lock per key, and settle when the run ends: commit if a PayPal action on the run succeeded, release if none did, hold if any outcome is unknown.

**Audit.** Each decision row (`authority_decisions`) stores the request, every check with a readable sentence, the budget snapshot (limit, spent, reserved, request, after), the authority snapshot and version, the human approval if any, and links to the reservation and the execution. The audit chain records `authority.decision`, `budget.committed/released/held`, `approval.approved/rejected`, and the PayPal result, so every payment reads as: requested by → workflow · authorized by → authority vN · checks → … · decision → ALLOW/REVIEW/DENY · person → … · executed through → PayPal · result → ids, status, debug_id.

### GatePal seam

`authorityProvider()` (`src/server/authority/index.ts`) is the single point that chooses who decides. Today it returns PayFlow's `InternalAuthorityProvider` (`PayFlow → PayFlow authority → PayPal`). An external authority service implements the same `AuthorityProvider` contract — `authorize` (check + reserve), `linkExecution`, `settle` (commit/release/hold), `usable` (pre-send re-check) — and is returned there instead (`PayFlow → GatePal → PayPal`). Decisions already record which provider made them. PayFlow does not depend on GatePal.

### Development: stale workers

A worker logs its git commit and a content hash of its source when it starts and writes a heartbeat (`worker_heartbeats`, shown in Settings). Before every job it checks that the source on disk is unchanged; if not, it hands the job back to the queue for a fresh worker and exits (code 75), so edited code can never run as old code. `pnpm worker:status` / `worker:stop` / `worker:fresh` find and stop only processes whose command line contains this checkout's path *and* `src/worker/index.ts`.

## 13. AI financial intelligence (Phase 7)

**AI = financial analyst. Authority engine = financial controller. Person = reviewer. PayPal = settlement.** The model interprets, classifies, compares and explains; it never permits money to move.

```
AI node ─► prepare (code: resolve inputs, history signals, injection scan, skip the model if not needed)
        ─► ensureAnalysis (content-addressed cache; single-flight) ─► runAnalysis (outside any tx)
        ─► provider.analyze(fenced input, PayFlow schema) ─► validate · ≤1 repair ─► post-process (verify quotes)
        ─► step output = EVIDENCE ─► action node ─► authority: evaluateEvidence under the authority's own policy
```

**Five executable AI nodes** (`src/server/intelligence/`):
- `ai.invoice_extract` — counterparty, invoice number, amount, currency, due date, purpose, terms, line items; each field is `SOURCE_PROVIDED`, `AI_EXTRACTED` (only if its quote is verbatim in the document and the value is in the quote) or `NOT_FOUND`. Source vs document disagreements are deterministic **conflicts**.
- `ai.contract_match` — invoice vs supplied contract: `MATCH / MISMATCH / UNCERTAIN` with quoted findings. No contract → no call, UNCERTAIN.
- `ai.purpose_classification` — `WITHIN_SCOPE / OUTSIDE_SCOPE / UNCERTAIN` against the **covering authority's own purpose text** (its hash is recorded; a changed scope makes old evidence stale).
- `ai.behavior_analysis` — signals are **calculated by code** from PayFlow's payment history (`signals.ts`: new counterparty, deviation from median, currency change, frequency burst with a history minimum, duplicate invoice number, same amount in 24 h; levels `LOW / ELEVATED / HIGH / UNCERTAIN` by stated rules, no scores). The model is called only when a signal fires, to explain in plain words and judge consistency with earlier invoices; it may **raise** the level to ELEVATED, never lower it.
- `ai.invoice_match` — exact deterministic match first; the model only chooses among several candidates, and its choice must be one of them.

**Policy decides.** Each authority has a purpose scope and an `intelligencePolicy` (owner-set, audited): outside purpose → review/deny; uncertain purpose → review/deny; elevated risk → allow/review/deny; high risk → review/deny; contract mismatch → review/deny; contract uncertain → allow/review; injection → review/deny; extraction conflict → review; AI unavailable → review/deny. Ambiguity (uncertain purpose, injection, AI unavailable) can **never** be set to allow. Evidence must describe this exact request (amount, counterparty) or it is ignored as stale and the request is reviewed. AI-derived checks are marked `source: "ai"` and shown as interpretation, never as fact.

**Untrusted content.** Documents reach the model only inside fences carrying a random per-call nonce; fence-like text inside a document is neutralised. A fixed preamble tells the model that fenced content is data, never instructions. Independently, `scanForInjection` flags text that tries to instruct an AI (ignore instructions, approve, change limits, redirect funds, exfiltrate, call tools, rewrite workflow, spoof output); any hit is evidence the policy acts on — the protection holds even if the model is fooled (tested by disabling the scanner: the test fails).

**Structured outputs only.** Every task has a flat, all-required PayFlow schema with enum verdicts (`schemas.ts`), enforced by the provider's strict mode and re-parsed by PayFlow. Malformed → one controlled repair; still malformed or provider error → the analysis fails → **UNCERTAIN → review**. Contradictions (MATCH with a MISMATCH finding) and unverifiable quotes are downgraded deterministically. No tools are ever offered; the AI and intelligence modules import no PayPal or action code (checked by a test).

**Provenance and cost.** `ai_analyses` stores provider, model, prompt version and hash (instructions + JSON schema), input hash, the trusted context and documents, the validated output, validation result (repairs, injection patterns), usage, cost and cache hits — never chain-of-thought or credentials. Every call goes through the metered provider (lifetime budget) plus an optional phase cap (`AI_PHASE_CAP_USD` since `AI_PHASE_SINCE`).

**Cache.** Key = task + prompt/schema version + model + exact inputs. Same key → the validated result is reused (audited `ai.analysis.cache_hit`); a changed character → a new analysis. Concurrent runs that need the same analysis share one call (lease + wait). **Authority decisions are never cached**: each request is decided afresh over the (possibly cached) evidence.

### GatePal seam

The intelligence pieces are plain modules with PayFlow-owned types — intent (`AuthorityRequest`), purpose evidence, contract evidence, behavioural signals, risk evidence — and the authority engine consumes them through `AuthorityRequest.evidence`. An external authority service could receive the same evidence (or compute its own) behind `AuthorityProvider`; PayFlow does not depend on it.
