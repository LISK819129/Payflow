import { ArrowLeft, Ban, Check, X } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CredentialControls } from "@/components/agents/credential-controls";
import { ago, RequestState } from "@/components/agents/request-state";
import { formatClock, formatDay, Section } from "@/components/ui";
import { getAgent } from "@/server/agents/queries";
import { NEVER } from "@/server/agents/service";
import { requireUser } from "@/server/auth/current";

export const dynamic = "force-dynamic";

export default async function AgentPage(props: PageProps<"/agents/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const a = await getAgent(user.workspaceId, id);
  if (!a) notFound();
  const now = new Date();
  const expired = !!a.expiresAt && a.expiresAt <= now;
  const active = a.status === "ACTIVE" && !expired;

  return (
    <div className="animate-fade-up">
      <Link href="/agents" className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Agents
      </Link>
      <header className="mt-4 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="pf-label">AI agent · owner {a.ownerEmail}</div>
          <h1 className="mt-1 text-headline font-semibold tracking-[-0.02em]">{a.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {active ? (
              <span className="inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.08em] text-ink">
                <span aria-hidden className="size-2 rounded-full bg-marker" /> Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.08em] text-danger">
                <Ban size={12} aria-hidden /> {a.status === "REVOKED" ? `Revoked ${a.revokedAt ? `${formatDay(a.revokedAt)} ${formatClock(a.revokedAt)}` : ""}` : "Expired"}
              </span>
            )}
            <span className="font-mono text-meta text-muted">id {a.id}</span>
          </div>
          {a.revokeReason && <p className="mt-1 text-body-sm text-muted">Reason: {a.revokeReason}</p>}
        </div>
        {user.role === "OWNER" && <CredentialControls agentId={a.id} active={active} />}
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <Section label="Can request (permission to ask — not authority to pay)">
          <ul className="mt-3 space-y-3">
            {a.scopeNames.map((s) => (
              <li key={s.workflowId} className="flex items-start gap-2">
                <Check size={15} strokeWidth={2.5} className="mt-0.5 text-marker-ink" aria-hidden />
                <div>
                  <Link href={`/flows/${s.workflowId}`} className="font-medium text-ink hover:underline">
                    {s.name}
                  </Link>{" "}
                  → {s.actions.map((x) => x.replace("paypal.", "")).join(", ")}
                  <div className="font-mono text-meta text-muted">{s.modes.join(" + ")} requests</div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-body-sm text-muted">Every request is still decided by that workflow&rsquo;s authority (limits, recipients, budget, purpose), PayFlow&rsquo;s intelligence and, when needed, a person.</p>
        </Section>
        <Section label="Can never">
          <ul className="mt-3 space-y-2">
            {NEVER.map((n) => (
              <li key={n} className="flex items-start gap-2 text-body text-ink-2">
                <X size={15} strokeWidth={2.5} className="mt-0.5 text-danger" aria-hidden /> {n}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section label="Credential" className="mt-10">
        <dl className="mt-3 grid gap-x-10 gap-y-2 text-body sm:grid-cols-[180px_1fr]">
          <dt className="text-muted">Bearer token</dt>
          <dd className="font-mono text-meta">pfa_{a.credentialId}_… (only its SHA-256 is stored)</dd>
          <dt className="text-muted">Version</dt>
          <dd>
            v{a.credentialVersion}, issued {formatDay(a.credentialIssuedAt)} {formatClock(a.credentialIssuedAt)}
          </dd>
          <dt className="text-muted">Expires</dt>
          <dd>{a.expiresAt ? `${formatDay(a.expiresAt)}${expired ? " (expired)" : ""}` : "never — until revoked"}</dd>
          <dt className="text-muted">Last call</dt>
          <dd>
            {ago(a.lastUsedAt, now)} {a.lastUsedTool && <span className="font-mono text-meta text-muted">· {a.lastUsedTool}</span>}
          </dd>
          <dt className="text-muted">Endpoint</dt>
          <dd className="font-mono text-meta">POST /api/mcp (MCP Streamable HTTP)</dd>
        </dl>
      </Section>

      <Section label="Requests" aside={`${a.requests.length} most recent`} className="mt-10">
        {a.requests.length === 0 ? (
          <p className="py-4 text-body-sm text-muted">No requests yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {a.requests.map((r) => {
              const e = r.envelope as { action: string; amount: { value: string; currency: string }; counterparty: string | null; captureId: string | null; purpose: string };
              return (
                <li key={r.id}>
                  <Link href={`/agents/requests/${r.reference}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 hover:bg-sunken/60 md:grid-cols-[150px_110px_minmax(0,1fr)_auto]">
                    <span className="hidden font-mono text-meta text-muted md:inline">
                      {formatDay(r.createdAt)} {formatClock(r.createdAt)}
                    </span>
                    <span className="hidden font-mono text-meta text-ink md:inline">{r.reference}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-body">
                        {r.mode === "TEST" && <span className="mr-1.5 font-mono text-meta text-sim">TEST</span>}
                        {e.action.replace("paypal.", "")} {e.amount.value} {e.amount.currency} → {e.counterparty ?? e.captureId}
                      </span>
                      <span className="block truncate text-meta text-muted">“{e.purpose}” · request_id {r.requestId}</span>
                    </span>
                    <RequestState state={r.state} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
