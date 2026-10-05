/**
 * Builds evidence/phase10/manifest.json from the databases (not typed by hand).
 *
 * - judge: the fresh judge database used for the production rehearsal (its
 *   demo setup, the Test Runs with their verdicts and AI labels, the pending
 *   agent request, AI spend there, audit-chain check).
 * - main: the development database (AI spend since Phase 9, historical Phase 9
 *   payouts under the truthful settlement model, receipt verification, audit).
 *
 *   JUDGE_DATABASE_URL=<…/payflow_judge> pnpm evidence:manifest:phase10
 */
import "../load-env";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { settlementOf, type ResourceEvent } from "../../src/server/actions/settlement";

const OUT = path.resolve("evidence/phase10");
/** Phase 10 began after the Phase 9 commit (0538c8c). */
const START = "2026-10-05T07:53:14Z";

function files(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.some((e) => f.endsWith(e)) ? [path.relative(OUT, p).replaceAll("\\", "/")] : [];
  });
}

async function chainOk(pool: Pool) {
  // Recompute via the app's verifier in-process would need the app's db(); here: monotonic seq and prev-hash linkage.
  const { rows } = await pool.query<{ workspace_id: string; seq: string; hash: string; prev_hash: string }>("select workspace_id, seq, hash, prev_hash from audit_records order by workspace_id, seq");
  let ok = true;
  let last: { ws: string; seq: number; hash: string } | null = null;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (last && last.ws === r.workspace_id && (seq !== last.seq + 1 || r.prev_hash !== last.hash)) ok = false;
    last = { ws: r.workspace_id, seq, hash: r.hash };
  }
  return { linkage_ok: ok, records: rows.length, note: "seq + prev_hash linkage; full hash recomputation is `verifyChain` (run in the regression)" };
}

async function judge(url: string) {
  const pool = new Pool({ connectionString: url });
  try {
    const q = async <T extends object>(sql: string) => (await pool.query<T & Record<string, unknown>>(sql)).rows;
    return {
      database: "fresh judge database (production rehearsal: next build + next start, NODE_ENV=production)",
      demo_setup: {
        workflows: await q("select name, demo_key, state from workflows order by name"),
        authorities: await q("select name, demo_key, version, per_transaction_max, budget_amount, budget_period, counterparties from authorities order by name"),
        agents: await q("select name, demo_key, status, scopes, credential_version, expires_at from agents order by created_at"),
      },
      test_runs: await q(
        "select id, verdict, headline, (select string_agg(x->>'task'||':'||(x->>'label'), ', ') from jsonb_array_elements(ai) x) as ai_labels, external_actions_disabled, created_at from simulations order by created_at",
      ),
      agent_requests: await q("select reference, request_id, mode, state, receipt_hash, jsonb_array_length(links) as links from agent_requests order by created_at"),
      live_records: (await q<{ runs: string; executions: string; approvals_pending: string; paypal_events: string }>(
        "select (select count(*) from workflow_runs) runs, (select count(*) from action_executions) executions, (select count(*) from approvals where status='PENDING') approvals_pending, (select count(*) from paypal_events) paypal_events",
      ))[0],
      openai: (await q("select count(*)::int calls, coalesce(sum(cost_usd::numeric),0)::text cost_usd from ai_usage"))[0],
      audit: await chainOk(pool),
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const mainPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async <T extends object>(sql: string, p: unknown[] = []) => (await mainPool.query<T & Record<string, unknown>>(sql, p)).rows;
  const phaseAi = (await q(`select count(*)::int calls, coalesce(sum(cost_usd::numeric),0)::text cost_usd from ai_usage where at >= $1`, [START]))[0];
  const life = (await q(`select count(*)::int calls, coalesce(sum(cost_usd::numeric),0)::text cost_usd from ai_usage`))[0];
  const exs = await q<{ id: string; kind: string; status: string; attempts: number; paypal_status: string | null; paypal_refs: string[]; error: unknown; confirmed_by_event_id: string | null; workspace_id: string }>(
    "select e.id, e.kind, e.status, e.attempts, e.paypal_status, e.paypal_refs, e.error, e.confirmed_by_event_id, e.workspace_id from action_executions e join agent_requests a on a.run_id = e.run_id",
  );
  const historical = [];
  for (const e of exs) {
    const evs = await q<{ event_type: string; status: string | null }>(
      `select event_type, coalesce(raw->'resource'->>'transaction_status', raw->'resource'->'batch_header'->>'batch_status', raw->'resource'->>'status') as status from paypal_events where workspace_id=$1 and (raw->'resource'->>'payout_batch_id' = any($2) or raw->'resource'->'batch_header'->>'payout_batch_id' = any($2)) order by received_at`,
      [e.workspace_id, e.paypal_refs],
    );
    const st = settlementOf(
      { kind: e.kind, status: e.status as never, attempts: e.attempts, paypalStatus: e.paypal_status, paypalRefs: e.paypal_refs, error: e.error, confirmedByEventId: e.confirmed_by_event_id },
      evs.map((x): ResourceEvent => ({ eventType: x.event_type, status: x.status })),
    );
    historical.push({ paypal_ids: e.paypal_refs, phase9_label: "COMPLETED (meaning: PayPal accepted)", paypal_said: evs.map((x) => `${x.event_type}=${x.status}`), now_presented_as: `${st.label} (${st.stage}, final=${st.final})` });
  }
  const mainInfo = {
    database: "development database (Phases 2–9 history)",
    openai_phase10: phaseAi,
    openai_lifetime: life,
    historical_payouts_under_truthful_status: historical,
    receipts: await q("select reference, state, jsonb_array_length(links) as links from agent_requests order by created_at"),
    audit: await chainOk(mainPool),
  };
  await mainPool.end();

  const manifest = {
    phase: 10,
    generatedAt: new Date().toISOString(),
    labels: {
      REAL_OPENAI: "a real OpenAI (gpt-5.4-mini) analysis, metered and capped",
      CACHED_AI_ANALYSIS: "an earlier real OpenAI result reused from the cache — no new call",
      TEST_INPUT: "a Test Run: real engine, rolled back, PayPal not contacted, no budget reserved",
      DEMO_SETUP: "configuration created by `pnpm demo:restore` (workflows, authorities, agent) — never payments or PayPal records",
      REAL_PAYPAL_SANDBOX: "records PayPal produced (Phase 9 payouts and their webhooks); no PayPal transactions were made in Phase 10",
      MOCK_TEST: "tests/phase10.test.ts and the rest of the suite (fake PayPal, mock analyst)",
    },
    judge: process.env.JUDGE_DATABASE_URL ? await judge(process.env.JUDGE_DATABASE_URL) : "JUDGE_DATABASE_URL not set",
    main: mainInfo,
    screenshots: files(OUT, [".png"]).sort(),
    other: files(OUT, [".json", ".txt"]).filter((f) => f !== "manifest.json").sort(),
  };
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const j = manifest.judge as { openai?: { calls: number; cost_usd: string }; test_runs?: { verdict: string }[] };
  console.log(`wrote evidence/phase10/manifest.json · judge test runs ${(j.test_runs ?? []).map((t) => t.verdict).join(", ")} · judge OpenAI ${j.openai?.calls} calls $${j.openai?.cost_usd} · main OpenAI since Phase 9 ${phaseAi.calls} calls $${phaseAi.cost_usd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
