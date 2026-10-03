import { CopyId, PageHeader, Section, SetupRequired, Status } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { env, integrationStatus } from "@/server/config/env";
import { describeConnection } from "@/server/paypal/capabilities";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUser();
  const status = integrationStatus();
  const e = env();
  const conn = status.paypal.configured ? await describeConnection() : null;

  return (
    <>
      <PageHeader title="Settings" lead="Connections PayFlow depends on. Nothing here is cached from a previous check: it is read live." />

      <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[1.3fr_1fr]">
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
              {status.ai.configured ? <Status tone="ok">Anthropic key present</Status> : <SetupRequired />}
              <p className="mt-1 text-body-sm text-muted">Used only by the workflow compiler and analysis nodes. Never authorises money movement.</p>
            </div>
          </Section>
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
