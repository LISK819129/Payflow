# PayFlow Architecture

> AI interprets. Code enforces. Humans authorize. PayPal executes.

## 1. Shape of the system

```
                 ┌───────────────────────── Next.js app (Render web service) ─────────────────────────┐
 Browser ───────▶│ UI (React, XYFlow canvas)   API route handlers (thin: auth → call a server module) │
 External agent ▶│ PayFlow MCP endpoint /api/mcp  (agents: MCP only)                                  │
 PayPal ────────▶│ POST /api/webhooks/paypal  → verify → persist (unique event id) → enqueue          │
                 └──────────────────────────────────────┬─────────────────────────────────────────────┘
                                                        │ Postgres (single source of truth)
                 ┌──────────────────────────────────────▼─────────────────────────────────────────────┐
                 │ Worker (Render background worker): pg-boss queues                                  │
                 │  webhook.route  → match event to ACTIVE workflow versions → start runs             │
                 │  run.step       → deterministic interpreter advances one run                       │
                 │  run.timer      → delay / due-date nodes wake runs                                 │
                 │  schedule.tick  → schedule triggers                                                │
                 │  observe-event  → after live routing: observing drafts evaluate the real event     │
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
| simulation | `src/server/simulation` | Test Run and Observe Mode: the real runtime inside a rolled-back transaction, with no PayPal write capability (§14) |
| agents | `src/server/agents` | Agent Gateway: agent identity and credentials, request envelope, idempotency, Intent Receipts, binding check, PayFlow's MCP server (§15) |
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
| Test Run / Observe Mode | in-process (one rolled-back transaction per evaluation) | Render Workflows task per batch — **deferred to Phase 11** (Phase 8 needed no fan-out): Workflows has no native scheduling or sleep, so it does not replace pg-boss for timers/approvals, but parallel simulation is a genuine fit |
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

## 14. Test Run and Observe Mode (Phase 8)

**What it is not.** Neither feature forecasts or predicts anything. A Test Run answers *"how does this saved version of the workflow handle this transaction, right now?"*; Observe Mode answers *"how did this draft evaluate that real PayPal event, at that moment?"*. Every result says it can differ in live use if the transaction, authority, budgets, workflow version, AI analysis or PayPal state change.

| Mode | Input | Provenance label | Can move money |
|---|---|---|---|
| LIVE | real event / schedule / manual run of an ACTIVE version | `REAL_PAYPAL_SANDBOX` / `USER_PROVIDED` | yes, through the authority engine |
| TEST | a person's hypothetical input ("Test this flow") | `TEST_INPUT` | **no** |
| OBSERVE | a real, PayPal-confirmed webhook, given to drafts with Observe on | `REAL_PAYPAL_EVENT_OBSERVED` | **no** |

**The real engine, inside a transaction that is always rolled back** (`src/server/simulation/run.ts`). `simulate()` opens one transaction, inserts a run row, and calls the same `advanceRun` used live — conditions, policy nodes, AI evidence nodes, the authority engine (CHECK → RESERVE under `FOR UPDATE`), approvals. The engine's three side-effect ports are injected through `RuntimeDeps`:

```
transaction ─► the sandbox's own transaction (all reads see the sandbox rows)
actions     ─► records "would execute" and stops; holds no PayPal capability
analysis    ─► stops and asks for the analysis it needs (computed outside, then the pass replays)
```

When the pass ends, the captured state (path, step results, authority decision with its budget snapshot, approvals, the would-be action) is thrown out in a `Rollback` error, so every reservation, decision, approval, run and step written during the pass disappears. Only two rows persist: the `simulations` record and an audit line *"TEST RUN — no money moved, PayPal not contacted"* (or *OBSERVED REAL EVENT …*).

**No PayPal write capability — by construction, not by `if (testMode)`.** Four independent layers:
1. The sandbox's action port has no gateway at all; it only records the intent.
2. `runAction` requires a `PayPalWrite` capability; `livePayPalWrite()` refuses to mint one inside a sandbox (`AsyncLocalStorage` mode from `withSandbox`, which only accepts TEST or OBSERVE — there is no way to enter LIVE from inside).
3. `DirectPayPalGateway.execute` calls `assertLiveWrite` before anything else.
4. `PayPalHttp.request` (any non-GET) and the SDK refund/capture operations call `assertLiveWrite` before a request leaves.
Test 20 deliberately calls each layer from inside a sandbox; all refuse, and a fake PayPal records zero calls. Removing layer 1 makes 6 tests fail; committing instead of rolling back makes 11 fail.

**AI in a test.** An analysis the test needs is computed **outside** the rolled-back transaction through the normal cached, metered runner, so it keeps its provenance and budget enforcement; the pass then replays and reads it. Labels per analysis: `CACHED_AI_ANALYSIS` (an earlier real result, no new call), `REAL_OPENAI` (computed for this test), `MOCK_TEST` (mock analyst), `AI_UNAVAILABLE` (refused — e.g. by the phase cap — and treated as UNCERTAIN → review), `CALCULATED_BY_PAYFLOW` (code, no AI). Only analyses actually computed during the test count as fresh; one found already done is a cache hit.

**Approvals.** A test that reaches a review shows *Assume approved / Assume rejected*. The choice is applied to the approval row **inside the rolled-back transaction** and the path continues; a new `simulations` record is linked to its parent. No approval is ever created, no one is notified, and nothing is authorised. A test record has no run id, so it cannot be resumed, approved or executed.

**Budgets.** The authority engine reserves inside the sandbox exactly as live — and the reservation is rolled back. The record keeps the snapshot it read (limit, spent, reserved, request, after); "Real budget reserved: $0".

**Observe Mode.** The owner toggles Observe on a workflow whose latest version is a DRAFT (audited `observe.enabled`). After the worker routes a real event live (`routePayPalEvent`, which confirms it with PayPal's event API first), it queues a separate `observe-event` job — observation can never delay or fail live routing. `observeEvent` accepts only `REAL_PAYPAL_SANDBOX` events that have been routed, finds observing workflows whose latest version's PayPal trigger lists the event type (and whose filter passes), and runs `simulate({ mode: "OBSERVE" })`. A unique index on (workflow, graph hash, PayPal event id) makes it idempotent.

**Versioning.** Every record stores the workflow version id and number, the full graph and its hash, the authority ids and versions, the input, the evaluation time and the provenance. Editing a draft never changes past observations.

**UI.** Flow Builder: *Test this flow* (fields derived from the graph's `trigger.*` references; disabled while there are unsaved edits) and *Observe* for drafts. Result page `/simulations/[id]`: TEST RUN / OBSERVED banner, verdict (`WOULD_ALLOW / WOULD_REVIEW / WOULD_DENY / WOULD_END / WOULD_WAIT / WOULD_SUSPEND`), PayPal *Not contacted*, Money moved *$0*, Real budget reserved *$0*, the highlighted path, each step, the authority trace and the Intelligence panel. Observation feed `/flows/[id]/observations`.

## 15. Agent Gateway & MCP (Phase 9)

**The agent asks. PayFlow decides. PayPal settles.** External AI agents never reach PayPal; they reach PayFlow's own MCP server, and every request goes through the same engine as any other run.

```
AI agent ──MCP (Streamable HTTP)──► POST /api/mcp
   size limit (64 KB) → per-IP limit on failed auth → bearer auth (status + expiry re-read every call) → per-agent limits
   → stateless McpServer bound to that agent (7 tools)
        payflow_request_payment / _refund / _test_request
          strict envelope (zod .strict(): unknown fields reject the call) → scope (workflow + action + mode)
          → idempotency (agent, request_id) → Intent Receipt (hashed, audit-anchored)
          → LIVE: startRunTx in the same transaction  ·  TEST: Phase 8 simulate() (no PayPal capability)
   → normal engine: policies · AI evidence · authority CHECK/RESERVE · approvals · binding check · PayPal · reconciliation · audit
```

**Identity** (`agents`). Immutable id, name, accountable owner (a person — the agent never inherits their permissions), status ACTIVE/REVOKED, scopes, expiry, last use. Credential `pfa_<credentialId>_<secret>`: only SHA-256(secret) is stored (a high-entropy secret needs no password KDF); compared in constant time; shown once at creation or rotation. Rotation swaps the hash (old token stops immediately); revocation takes the agent row `FOR UPDATE`, withdraws its requests waiting for a person, and is checked again at send time. Failed attempts by a known agent are audited (`agent.auth.refused`, at most once a minute). Spec note: MCP's optional HTTP authorization is OAuth 2.1; PayFlow uses a scoped, revocable bearer credential per agent, returned with `WWW-Authenticate: Bearer` on refusal. OAuth is a later step.

**Least privilege.** A scope is `{ workflowId, actions: payout|refund, modes: LIVE|TEST }` — *permission to ask*. The workflow must be ACTIVE, start with `trigger.agent_request`, accept that action and contain a node for it. *Authority to move money* stays with the workflow's authority (limits, recipients, currency, budget, frequency, purpose policy) and, when it says REVIEW, a person. There is no tool to approve, edit authority or workflows, read secrets, or call PayPal; `decideApproval` itself refuses anyone who is not an OWNER/APPROVER user of the workspace.

**Envelope** (`agents/envelope.ts`). `request_id`, `workflow_id`, `amount {value, currency}` (exact decimal, ISO code), `counterparty` (email) or `capture_id`, `purpose`, `reference`, `evidence {invoice_text, contract_text}`. Free text is data for the intelligence nodes (fenced, scanned for injection) — never a command. The agent's identity comes from the credential, never the envelope. Normalised (e.g. `185` → `185.00`, lower-case email) and hashed with the mode.

**Idempotency.** Unique `(agent_id, request_id)`. Same request again → the existing request (`replayed: true`); a different request under the same id (amount, recipient, purpose, evidence or mode) → `IDEMPOTENCY_CONFLICT`. Concurrent duplicates serialise on the unique index; the run is keyed `agent:<request id>` on `(version, triggerRef)` as a second guard.

**Intent Receipt** (`agents/receipt.ts`). Written once at acceptance: requester (agent, owner, credential version), request (action, amount, recipient, purpose, reference, request_id), evidence by SHA-256, workflow id/version/graph hash, authorities and versions at acceptance, request hash, timestamp, and a statement that it authorizes nothing. Canonical JSON → SHA-256, anchored in the audit chain (`agent.request.accepted`). What happens next is a hash chain of links on that hash — authority decision (with the authority versions actually used), human review requested/decided, PayPal result, final state, PayPal webhook confirmation — each anchored too (`agent.receipt.linked`). `verifyReceipt` recomputes everything and compares with the anchors, so editing a receipt, or a receipt and its stored hash together, is detected.

**Binding.** In an agent-started run, every money-moving action must be exactly what the receipt says: same kind, amount and currency, recipient or capture — checked when the action is prepared and again in the execution preflight immediately before PayPal, together with receipt integrity and the agent still being active and unexpired. Otherwise the action is not sent (`INTENT_MISMATCH`, `RECEIPT_TAMPERED`, `AGENT_REVOKED`…). Removing the preflight check fails 1 test; removing the prepare check fails 3.

**States returned to agents.** `ACCEPTED`, `PROCESSING`, `REVIEW_REQUIRED`, `APPROVED`, `REJECTED`, `DENIED`, `CANCELLED`, `COMPLETED` (PayPal accepted the action — never inferred from acceptance), `FAILED`, `UNKNOWN`, `ENDED`, and `TEST_COMPLETE` for tests; with machine-readable reason codes (`AMOUNT_OVER_TRANSACTION_LIMIT`, `PURPOSE_NOT_WITHIN_SCOPE`, `INSTRUCTIONS_IN_UNTRUSTED_TEXT`, `COUNTERPARTY_DENIED`, …), the authority decision and versions, human-review status and the PayPal result. Derived from the engine's own rows; the worker re-syncs after every advance.

**TEST requests.** `payflow_test_request` runs Phase 8's Test Run (rolled-back transaction, no write capability). A TEST request id is hashed with its mode, so it can never be replayed as LIVE.

**UI.** Agents page (register with scopes and expiry, credential shown once), agent page (can request / can never, credential, rotate, revoke, requests), request page (pipeline, reasons, verified receipt and its chain, evidence), a "Requested by AI agent" banner and pipeline on executions, and the requester on approval cards.

**PayPal AI resources.** PayPal's MCP server and Agent Toolkit authenticate with the merchant's client credentials — full merchant access, with no per-agent identity, budget or approval. PayFlow deliberately does not hand them to agents; it is the controlled layer in front of PayPal. The Agent Toolkit has no payouts tool, which PayFlow's procurement case needs; PayFlow settles through its own audited adapter. During Phase 9 the PayPal Sandbox MCP server (connected to the development session, operator side only) was tried once, read-only, to cross-check the agent payouts; its own session failed authentication (401), so PayPal-side confirmation comes from PayPal's verified webhooks instead.
