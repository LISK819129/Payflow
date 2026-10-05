import { ArrowRight, BookOpen, FlaskConical, Sparkles } from "lucide-react";
import Link from "next/link";
import { buttonClass, Section, formatClock, formatDay } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { homeSnapshot, TRY_EXAMPLES } from "@/server/demo/queries";

export const dynamic = "force-dynamic";

function Pipeline({ label, steps }: { label: string; steps: string[] }) {
  return (
    <div>
      <div className="pf-label">{label}</div>
      <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5" aria-label={label}>
        {steps.map((s, i) => (
          <li key={s} className="inline-flex items-center gap-1.5">
            <span
              className={`rounded-sm border px-2 py-1 font-mono text-[12px] font-medium tracking-[0.02em] ${
                i === steps.length - 1 ? "border-ink bg-ink text-surface" : s === "PayFlow" || s.startsWith("Authority") ? "border-marker bg-marker-wash text-ink" : "border-line text-ink-2"
              }`}
            >
              {s}
            </span>
            {i < steps.length - 1 && <ArrowRight size={12} className="text-faint" aria-hidden />}
          </li>
        ))}
      </ol>
    </div>
  );
}

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
        <h1 id="hero" className="text-[36px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[48px]">
          Give AI permission to ask.
          <br />
          <span className="pf-mark">PayFlow</span> decides whether money moves.
        </h1>
        <p className="mt-5 max-w-2xl text-lead text-ink-2">
          PayFlow is the financial permission layer between AI agents and real money. Agents and automated workflows can ask for payouts and refunds; PayFlow checks who is asking, what they were delegated, who they may pay, how much and what for — asks a person when a request goes beyond that — and only then does PayPal move the money.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-2">
          <a href="#try" className={buttonClass("primary", "lg")}>
            <Sparkles size={16} aria-hidden /> Try PayFlow
          </a>
          {s.cloudFlowId && (
            <Link href={`/flows/${s.cloudFlowId}?test=1`} className={buttonClass("secondary", "lg")}>
              <FlaskConical size={16} aria-hidden /> Test a payment — no money moves
            </Link>
          )}
          <Link href="/guide" className={buttonClass("quiet", "lg")}>
            <BookOpen size={16} aria-hidden /> 5-minute demo guide
          </Link>
        </div>
      </section>

      <section aria-label="How PayFlow works" className="mt-14 grid gap-8 border-t border-line pt-8 lg:grid-cols-2">
        <Pipeline label="When a person automates money" steps={["Instruction", "AI draft", "Test run", "Authority", "Intelligence", "Approval if needed", "PayPal"]} />
        <Pipeline label="When an AI agent asks" steps={["AI agent", "PayFlow", "Identity & scope", "Authority", "Intelligence", "Approval if needed", "PayPal"]} />
        <p className="text-body text-ink lg:col-span-2">
          <span className="font-semibold">AI proposes and requests. PayFlow authorizes. PayPal settles.</span> <span className="text-ink-2">No model, and no agent, ever holds PayPal credentials or approves its own request.</span>
        </p>
      </section>

      <section id="try" aria-labelledby="try-h" className="mt-14 scroll-mt-8">
        <h2 id="try-h" className="text-title font-semibold tracking-[-0.01em]">
          Try PayFlow
        </h2>
        <p className="mt-1 text-body-sm text-muted">Pick a starting point or write your own. It opens in the real AI compiler, which drafts a workflow you can inspect and test — it never activates anything on its own.</p>
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
        <Figure label="active flows" value={s.activeFlows} href="/flows" />
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
