import { ArrowRight, BookOpen, Check, FlaskConical, X } from "lucide-react";
import Link from "next/link";
import { buttonClass, Section, formatClock, formatDay } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { homeSnapshot, TRY_EXAMPLES } from "@/server/demo/queries";

export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean };
const DEMO_REQUESTS: { ask: string; to: string; checks: Check[]; outcome: "allow" | "review" | "deny"; result: string; why: string }[] = [
  { ask: "$185 · GPU compute", to: "Acme Cloud", checks: [{ name: "Supplier", ok: true }, { name: "Currency", ok: true }, { name: "Amount", ok: true }, { name: "Budget", ok: true }, { name: "Purpose", ok: true }], outcome: "allow", result: "Allowed", why: "Inside its authority — PayPal pays." },
  { ask: "$470 · digital gift cards", to: "Acme Cloud", checks: [{ name: "Supplier", ok: true }, { name: "Currency", ok: true }, { name: "Amount", ok: true }, { name: "Budget", ok: true }, { name: "Purpose", ok: false }], outcome: "review", result: "A person decides", why: "Outside the purpose this agent was authorized for." },
  { ask: "$650 · cloud compute", to: "AWS", checks: [{ name: "Supplier", ok: true }, { name: "Currency", ok: true }, { name: "Amount", ok: false }, { name: "Purpose", ok: true }], outcome: "review", result: "A person decides", why: "$150 over its limit. “Approve once” — the authority doesn’t change." },
  { ask: "$120 · GPU compute", to: "Blocked Vendor", checks: [{ name: "Supplier", ok: false }], outcome: "deny", result: "Denied", why: "On the deny list. PayPal is never contacted." },
];

function Figure({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="group block border-t-2 border-ink pt-3">
      <div className="text-figure font-semibold tracking-[-0.02em] text-ink">{value}</div>
      <div className="flex items-center gap-1 text-body-sm text-muted group-hover:text-ink">
        {label} <ArrowRight size={12} aria-hidden />
      </div>
    </Link>
  );
}

export default async function HomePage() {
  const user = await requireUser();
  const s = await homeSnapshot(user.workspaceId);

  return (
    <div className="animate-fade-up">
      <section aria-labelledby="hero" className="max-w-4xl">
        <div className="pf-label text-marker-ink">Financial authority for AI agents</div>
        <h1 id="hero" className="mt-3 text-[36px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[48px]">
          Give AI agents permission to ask —
          <br />
          not permission to pay.
        </h1>
        <p className="mt-5 max-w-2xl text-lead text-ink-2">
          An agent holding payment credentials can pay anyone, any amount, for anything. With <span className="font-medium text-ink">PayFlow</span>, the agent asks. PayFlow checks the request against the authority you delegated — to whom, how much, how often, for what, until when — and sends anything outside it to a person. Only then does PayPal move the money.
        </p>
        <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-title font-semibold tracking-[-0.01em]">
          <span>AI can ask.</span>
          <ArrowRight size={16} className="text-faint" aria-hidden />
          <span className="pf-mark">PayFlow decides.</span>
          <ArrowRight size={16} className="text-faint" aria-hidden />
          <span>PayPal moves the money.</span>
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <Link href="/guide" className={buttonClass("primary", "lg")}>
            <BookOpen size={16} aria-hidden /> See it in 3 minutes
          </Link>
          {s.cloudFlowId && (
            <Link href={`/flows/${s.cloudFlowId}?test=1`} className={buttonClass("secondary", "lg")}>
              <FlaskConical size={16} aria-hidden /> Try a request — no money moves
            </Link>
          )}
        </div>
      </section>

      <section aria-labelledby="example-h" className="mt-14">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
          <h2 id="example-h" className="pf-label">
            One agent, four requests
          </h2>
          <span className="text-meta text-muted">the demo setup — try each one with “Try a request”</span>
        </div>
        <p className="mt-4 max-w-3xl text-body text-ink">
          <span className="font-semibold">Cloud Procurement Agent</span> may ask to pay <span className="font-medium">Acme Cloud</span> and <span className="font-medium">AWS</span>, in USD, up to <span className="font-medium">$500</span> each and $5,000 a month, for <span className="font-medium">cloud infrastructure</span>. Never Blocked Vendor.
        </p>
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {DEMO_REQUESTS.map((r) => (
            <li key={r.ask} className="grid gap-x-6 gap-y-2 py-3.5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.75fr)_minmax(0,1.3fr)] md:items-center">
              <div>
                <div className="text-body font-medium text-ink">{r.ask}</div>
                <div className="text-body-sm text-muted">to {r.to}</div>
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Checks">
                {r.checks.map((c) => (
                  <span key={c.name} className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-meta ${c.ok ? "border-line text-ink-2" : r.outcome === "deny" ? "border-danger bg-danger-wash text-danger" : "border-warn bg-warn-wash text-warn"}`}>
                    {c.ok ? <Check size={12} className="text-ok" aria-hidden /> : <X size={12} aria-hidden />}
                    {c.name}
                    <span className="sr-only">{c.ok ? " passed" : " failed"}</span>
                  </span>
                ))}
              </div>
              <div>
                <div className={`text-body font-semibold ${r.outcome === "allow" ? "text-ok" : r.outcome === "deny" ? "text-danger" : "text-warn"}`}>{r.result}</div>
                <div className="text-body-sm text-ink-2">{r.why}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="why-h" className="mt-14 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 id="why-h" className="pf-label">
            Why not just give the agent a PayPal key?
          </h2>
          <p className="mt-3 text-body text-ink-2">
            A PayPal credential grants access to the payment APIs — to pay anyone, any amount, for anything. It can&rsquo;t say that <em>this</em> agent may pay only Acme Cloud or AWS, only in USD, only up to $500, only for cloud infrastructure, within a monthly budget, until a date — and that a person decides anything else. PayFlow keeps the credential behind that boundary. The agent holds permission to ask, not the ability to pay.
          </p>
        </div>
        <div>
          <h2 className="pf-label">What an agent can never do</h2>
          <ul className="mt-3 space-y-1.5 text-body text-ink-2">
            {["approve its own request", "raise its limits or widen its authority", "change the recipient or amount after a decision", "reach PayPal or see any credential"].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <X size={15} className="mt-1 shrink-0 text-danger" aria-hidden /> {t}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-body-sm text-muted">
            Every request gets an <span className="text-ink">Intent Receipt</span>: who asked, what, how much, to whom, why, under which authority — and what PayPal reported. Revoking an agent refuses its next call.
          </p>
        </div>
      </section>

      <section id="try" aria-labelledby="try-h" className="mt-14 scroll-mt-8">
        <h2 id="try-h" className="text-title font-semibold tracking-[-0.01em]">
          Write a payment rule in plain English
        </h2>
        <p className="mt-1 text-body-sm text-muted">The AI drafts a workflow — what should happen — and asks when something is unclear. PayFlow validates it and saves a draft; only a person can activate it, and its authority still bounds what it may pay.</p>
        <ul className="mt-5 grid gap-4 md:grid-cols-3">
          {TRY_EXAMPLES.map((e) => (
            <li key={e.title}>
              <Link href={`/flows?instruction=${encodeURIComponent(e.instruction)}#compile-h`} className="group flex h-full flex-col border border-line bg-surface p-5 transition-colors hover:border-ink">
                <span className="pf-label text-ink">{e.title}</span>
                <span className="mt-2 flex-1 text-body text-ink-2">“{e.instruction}”</span>
                <span className="mt-4 inline-flex items-center gap-1 text-body-sm font-medium text-ink">
                  Open in the compiler <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/flows#compile-h" className="mt-3 inline-flex items-center gap-1 text-body-sm text-muted hover:text-ink">
          Or describe your own <ArrowRight size={12} aria-hidden />
        </Link>
      </section>

      <section aria-label="Right now" className="mt-14 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Figure label={s.pending === 1 ? "needs your decision" : "need your decision"} value={s.pending} href="/approvals" />
        <Figure label="active workflows" value={s.activeFlows} href="/flows" />
        <Figure label="active AI agents" value={s.activeAgents} href="/agents" />
        <Figure label="agent requests" value={s.agentRequests} href="/agents" />
      </section>

      <Section
        label="Recent activity"
        className="mt-12"
        aside={
          <Link href="/audit" className="inline-flex items-center gap-1 hover:text-ink">
            Full audit trail <ArrowRight size={12} aria-hidden />
          </Link>
        }
      >
        {s.recent.length === 0 ? (
          <p className="py-4 text-body-sm text-muted">Nothing has happened yet. Everything PayFlow does will be recorded here, in a tamper-evident log.</p>
        ) : (
          <ol>
            {s.recent.map((r) => (
              <li key={r.id} className="flex gap-4 border-b border-line py-2.5 last:border-b-0">
                <span className="w-32 shrink-0 whitespace-nowrap pt-px font-mono text-meta text-faint" title={r.at.toISOString()}>
                  {formatDay(r.at)} {formatClock(r.at)}
                </span>
                <span className="min-w-0 text-body text-ink-2">{r.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
