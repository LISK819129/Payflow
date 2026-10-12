import { ArrowLeft, CircleX, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentBanner, AgentPipeline } from "@/components/agents/agent-pipeline";
import { RequestState } from "@/components/agents/request-state";
import { formatMoney, Section } from "@/components/ui";
import { getAgentRequestView } from "@/server/agents/queries";
import type { ReceiptLink } from "@/server/agents/receipt";
import { requireUser } from "@/server/auth/current";

export const dynamic = "force-dynamic";

/** Before this moment, a final state of COMPLETED meant "PayPal accepted the action" (Phase 9). */
const SETTLEMENT_SEMANTICS_FROM = new Date("2026-10-05T07:53:14Z");

/** Honest notes on historical links. The links themselves are hash-chained and are never edited. */
function linkNote(l: ReceiptLink, all: ReceiptLink[]): string | null {
  if (l.kind !== "final") return null;
  const state = (l.data as { state?: string }).state;
  const earlier = all.filter((x) => x.kind === "final" && x.seq < l.seq).at(-1);
  if (earlier && (earlier.data as { state?: string }).state === state) return "Repeat of the previous final state, recorded by a re-sync before repeats were prevented. Kept as recorded.";
  if (state === "COMPLETED" && new Date(l.at) < SETTLEMENT_SEMANTICS_FROM) return "Recorded under the earlier meaning of COMPLETED: PayPal had accepted the action. Settlement is reported by the links after it.";
  if (earlier) return `Correction of the earlier final state (${(earlier.data as { state?: string }).state}); both are kept.`;
  return null;
}

export default async function AgentRequestPage(props: PageProps<"/agents/requests/[reference]">) {
  const { reference } = await props.params;
  const user = await requireUser();
  if (!/^PF-[0-9A-Z]{8}$/.test(reference)) notFound();
  const v = await getAgentRequestView(user.workspaceId, { reference });
  if (!v) notFound();
  const r = v.receipt.request;

  return (
    <div className="animate-fade-up">
      <Link href={`/agents/${v.agent.id}`} className="inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> {v.agent.name}
      </Link>
      <div className="mt-4">
        <AgentBanner v={v} />
      </div>

      <header className="mt-5 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="pf-label">
            {r.action.replace("paypal.", "")} · {v.receipt.workflow.name} v{v.receipt.workflow.version}
          </div>
          <h1 className="mt-1 text-headline font-semibold tracking-[-0.02em]">
            {formatMoney(r.amount.value, r.amount.currency)} <span className="text-ink-2">→ {r.counterparty ?? r.capture_id}</span>
          </h1>
          <p className="mt-2 max-w-2xl text-body text-ink-2">“{r.purpose}”</p>
        </div>
        <div className="text-right">
          <RequestState state={v.status.state} />
          <p className="mt-2 max-w-sm text-body-sm text-muted">{v.status.meaning}</p>
        </div>
      </header>

      <Section label="Intent Receipt — in plain words" aside={v.verification.ok ? "integrity verified" : "integrity FAILED"} className="mt-8">
        <dl className="mt-3 grid gap-x-10 gap-y-2.5 text-body sm:grid-cols-[180px_minmax(0,1fr)]">
          {(
            [
              ["Who asked", `AI agent “${v.receipt.requester.agent_name}” (credential v${v.receipt.requester.credential_version}), owned by ${v.ownerEmail}`],
              ["What", r.action === "paypal.payout" ? "A payout" : r.action === "paypal.refund" ? "A refund" : r.action],
              ["How much", formatMoney(r.amount.value, r.amount.currency)],
              ["To whom", r.counterparty ?? `capture ${r.capture_id}`],
              ["Why (the agent's words)", `“${r.purpose}”${r.reference ? ` · ref ${r.reference}` : ""}`],
              ["Through", `${v.receipt.workflow.name} v${v.receipt.workflow.version}`],
              ["Under authority", v.status.authority?.authorities.map((a) => `${a.name} v${a.version}`).join(", ") || v.receipt.authority_at_acceptance.map((a) => `${a.name} v${a.version} (at acceptance)`).join(", ") || "none"],
              ["Did a person decide?", v.ar.mode === "TEST" ? "No — a TEST request never creates an approval" : v.status.human_review?.required ? `Yes — ${String(v.status.human_review.status ?? "").toLowerCase()}` : v.status.authority ? "No — within delegated authority" : "Not yet"],
              ["Was PayPal contacted?", v.ar.mode === "TEST" ? "No — TEST requests cannot reach PayPal" : v.status.paypal.contacted ? `Yes — ${v.status.paypal.ids.join(", ")}` : "No"],
              ["What happened", `${v.status.state.replaceAll("_", " ")} — ${v.status.meaning}`],
            ] as [string, string][]
          ).map(([q, a]) => (
            <div key={q} className="contents">
              <dt className="text-muted">{q}</dt>
              <dd className="min-w-0 break-words text-ink">{a}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <div className="mt-10">
        <AgentPipeline v={v} showRunLink />
      </div>


      {v.status.reasons.length > 0 && (
        <Section label="Reasons (as returned to the agent)" className="mt-10">
          <ul className="mt-2 space-y-1.5">
            {v.status.reasons.map((x) => (
              <li key={x.code + x.detail} className="grid grid-cols-[minmax(0,260px)_1fr] gap-4 text-body-sm">
                <span className="font-mono text-ink">{x.code}</span>
                <span className="text-ink-2">
                  {x.detail} {x.source === "ai" && <span className="font-mono text-meta text-marker-ink">AI evidence</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="mt-10 grid gap-10 xl:grid-cols-[1.1fr_1fr] [&>*]:min-w-0">
        <Section label="Intent receipt" aside={v.verification.ok ? "verified" : "FAILED verification"}>
          <div className={`mt-3 flex items-start gap-2 text-body-sm ${v.verification.ok ? "text-marker-ink" : "text-danger"}`}>
            {v.verification.ok ? <ShieldCheck size={16} aria-hidden /> : <CircleX size={16} aria-hidden />}
            <span>
              {v.verification.ok
                ? "Recomputed hash matches, and matches the copy anchored in the audit chain. Every link below follows from the one before."
                : v.verification.problems.join("; ")}
            </span>
          </div>
          <div className="mt-2 break-all font-mono text-meta text-muted">sha256 {v.ar.receiptHash}</div>
          <pre className="mt-3 max-h-[540px] overflow-auto whitespace-pre-wrap break-all rounded-sm bg-sunken p-3 font-mono text-meta text-ink-2">{JSON.stringify(v.receipt, null, 2)}</pre>
        </Section>
        <Section label="What happened next (hash-linked)" aside={`${v.links.length} link${v.links.length === 1 ? "" : "s"}`}>
          {v.links.length === 0 ? (
            <p className="py-4 text-body-sm text-muted">Nothing decided yet.</p>
          ) : (
            <ol className="mt-3 space-y-4">
              {v.links.map((l) => (
                <li key={l.seq} className="border-l-2 border-line pl-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="pf-label text-ink">
                      {l.seq}. {l.kind.replaceAll("_", " ")}
                    </span>
                    <span className="font-mono text-meta text-muted">{l.at.replace("T", " ").slice(0, 19)} UTC</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-meta text-ink-2">{JSON.stringify(l.data, null, 2)}</pre>
                  {linkNote(l, v.links) && <p className="mt-1 text-meta text-warn">{linkNote(l, v.links)}</p>}
                  <div className="mt-1 font-mono text-[10px] text-faint">
                    prev {l.prev.slice(0, 16)}… → {l.hash.slice(0, 16)}…
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      {(v.receipt.evidence.length > 0 || (v.ar.envelope as { evidence?: { invoiceText?: string | null } }).evidence?.invoiceText) && (
        <Section label="Evidence the agent supplied (untrusted data)" className="mt-10">
          <pre className="mt-3 max-h-72 overflow-auto rounded-sm bg-sunken p-3 font-mono text-meta text-ink-2">
            {(v.ar.envelope as { evidence: { invoiceText: string | null; contractText: string | null } }).evidence.invoiceText ?? ""}
            {(v.ar.envelope as { evidence: { contractText: string | null } }).evidence.contractText ? `\n\n--- contract ---\n${(v.ar.envelope as { evidence: { contractText: string } }).evidence.contractText}` : ""}
          </pre>
        </Section>
      )}
    </div>
  );
}
