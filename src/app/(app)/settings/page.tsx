import { CopyId, PageHeader, Section, SetupRequired, Status } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { env, integrationStatus } from "@/server/config/env";
import { describeConnection } from "@/server/paypal/capabilities";
import { compileModel } from "@/server/ai";
import { usageSummary } from "@/server/ai/usage";
import { db } from "@/server/db/client";
import { workerHeartbeats } from "@/server/db/schema";
import { gitInfo, sourceHash } from "@/server/dev/version";
import { desc, gt } from "drizzle-orm";
import { RestoreDemo } from "@/components/demo/restore-demo";
import { demoModeEnabled } from "@/server/demo/setup";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const code = { sourceHash: sourceHash(), ...gitInfo() };
  const now = new Date();
  const workers = await db().select().from(workerHeartbeats).where(gt(workerHeartbeats.lastSeenAt, new Date(now.getTime() - 3_600_000))).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(8);
  const user = await requireUser();
  const status = integrationStatus();
  const e = env();
  const [conn, usage] = await Promise.all([status.paypal.configured ? describeConnection() : Promise.resolve(null), usageSummary()]);
  const spent = Number(usage.total);
  const budget = Number(usage.budget);

  return (
    <>
      <PageHeader title="Settings" lead="Connections PayFlow depends on. Nothing here is cached from a previous check: it is read live." />

      <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
        <Section label="PayPal Sandbox" aside={conn?.ok && conn.appId ? <CopyId value={conn.appId} /> : undefined}>
          {!conn ? (
            <div className="py-4">
              <SetupRequired />
              <p className="mt-1 text-body text-muted">Add {status.paypal.missing.join(" and ")} to .env.local.</p>
            </div>
          ) : !conn.ok ? (
            <div className="py-4">
              <Status tone="danger">PayPal rejected the connection</Status>
              <p className="mt-1 font-mono text-meta text-muted">
                {conn.error.code} · {conn.error.message}
                {conn.error.debugId && ` · debug_id ${conn.error.debugId}`}
              </p>
            </div>
          ) : (
            <>
              <div className="py-4">
                <Status tone="ok">Connected · OAuth token valid</Status>
              </div>
              <h3 className="pf-label mb-1 mt-2">App permissions</h3>
              <ul>
                {conn.features.map((f) => (
                  <li key={f.key} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
                    <span className="w-44 shrink-0 text-body font-medium">{f.name}</span>
                    <span className="min-w-0 flex-1 text-body-sm text-muted">{f.usedFor}</span>
                    {f.granted ? <Status tone="ok">Granted</Status> : <Status tone="warn">Not enabled</Status>}
                  </li>
                ))}
              </ul>
              <h3 className="pf-label mb-1 mt-8">Webhooks</h3>
              {conn.webhooks.length === 0 ? (
                <div className="py-3">
                  <SetupRequired>No webhook registered</SetupRequired>
                </div>
              ) : (
                <ul>
                  {conn.webhooks.map((w) => (
                    <li key={w.id} className="border-b border-line py-2.5 last:border-b-0">
                      <div className="flex items-center justify-between gap-4">
                        <CopyId value={w.id} />
                        {w.id === e.PAYPAL_WEBHOOK_ID ? <Status tone="ok">Verifying with this ID</Status> : <Status tone="neutral">Not in use</Status>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-meta text-muted">
                        {w.url} · {w.eventTypes} event types
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>

        <div className="space-y-12">
          <Section label="AI provider">
            <div className="py-4">
              {status.ai.configured ? <Status tone="ok">{e.AI_PROVIDER === "openai" ? "OpenAI" : "Anthropic"} key present</Status> : <SetupRequired />}
              <p className="mt-1 text-body-sm text-muted">Used only by the workflow compiler and analysis nodes. Never authorises money movement.</p>
              <dl className="mt-3 grid grid-cols-[120px_1fr] gap-y-1 text-body-sm">
                <dt className="text-muted">Compiler</dt>
                <dd className="font-mono text-meta">{compileModel()}</dd>
                <dt className="text-muted">AI evidence</dt>
                <dd className="font-mono text-meta">{compileModel()}</dd>
              </dl>
            </div>
          </Section>
          <Section label="AI spend" aside={`hard budget $${budget.toFixed(2)}`}>
            <div className="py-4">
              <div className="text-title font-semibold">
                ${spent.toFixed(4)} <span className="text-body font-normal text-muted">of ${budget.toFixed(2)}</span>
              </div>
              <div className="mt-2 h-1.5 w-full rounded-sm bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent} aria-label="AI budget used">
                <div className="h-1.5 rounded-sm bg-ink" style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
              </div>
              <p className="mt-2 text-body-sm text-muted">
                {usage.calls} call{usage.calls === 1 ? "" : "s"} · {usage.input.toLocaleString()} input · {usage.output.toLocaleString()} output · {usage.cache_read.toLocaleString()} cached tokens. Calls that could cross the budget are refused before they are made.
              </p>
            </div>
          </Section>
          <Section label="Workers" aside={`app code ${code.sourceHash}${code.commit ? ` · ${code.commit}` : ""}`}>
            <div className="py-4">
              {workers.length === 0 ? (
                <Status tone="warn">No worker has reported in the last hour</Status>
              ) : (
                <ul className="space-y-1.5">
                  {workers.map((w) => {
                    const live = w.status === "RUNNING" && w.lastSeenAt.getTime() > now.getTime() - 60_000;
                    const stale = w.sourceHash !== code.sourceHash;
                    return (
                      <li key={w.id} className="flex flex-wrap items-center gap-x-3 font-mono text-meta">
                        {!live ? <Status tone="neutral">stopped</Status> : stale ? <Status tone="danger">stale code</Status> : <Status tone="ok">current code</Status>}
                        <span className="text-ink-2">
                          {w.id} · source {w.sourceHash}
                          {w.commit ? ` · ${w.commit}${w.dirty ? "*" : ""}` : ""}
                        </span>
                        {w.stopReason && <span className="text-muted">{w.stopReason}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-2 text-body-sm text-muted">A worker stops itself before running a job if the code changed after it started. Restart with pnpm worker:fresh.</p>
            </div>
          </Section>
          {demoModeEnabled() && (
            <Section label="Demo setup">
              <div className="py-4">
                <p className="mb-3 text-body-sm text-muted">
                  Puts the demo workflows, their authorities and the Cloud Procurement Agent back the way the demo starts — as new, audited versions. Runs, approvals, receipts, PayPal records and the audit trail are never deleted or changed. A revoked or expired demo agent is replaced by a newly registered one.
                </p>
                {user.role === "OWNER" ? <RestoreDemo /> : <p className="text-body-sm text-muted">Only the owner can restore the demo setup.</p>}
              </div>
            </Section>
          )}
          <Section label="Webhook simulator events">
            <div className="py-4">
              {e.PAYPAL_ALLOW_SIMULATOR_EVENTS ? <Status tone="warn">Accepted, labelled Simulated</Status> : <Status tone="neutral">Rejected</Status>}
              <p className="mt-1 text-body-sm text-muted">PAYPAL_ALLOW_SIMULATOR_EVENTS. Keep off outside development.</p>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
