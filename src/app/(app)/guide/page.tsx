import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { homeSnapshot, TRY_EXAMPLES } from "@/server/demo/queries";

export const dynamic = "force-dynamic";

function Step({ n, title, minutes, href, cta, children }: { n: number; title: string; minutes: string; href: string; cta: string; children: ReactNode }) {
  return (
    <li className="grid gap-4 border-t border-line py-6 md:grid-cols-[56px_minmax(0,1fr)_200px]">
      <span className="font-mono text-title text-faint" aria-hidden>
        {String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h2 className="text-title font-semibold">
          <span className="sr-only">Step {n}: </span>
          {title} <span className="ml-1 font-mono text-meta font-normal text-muted">{minutes}</span>
        </h2>
        <div className="mt-2 space-y-2 text-body text-ink-2">{children}</div>
      </div>
      <div className="md:text-right">
        <Link href={href} className="inline-flex items-center gap-1 text-body font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          {cta} <ArrowRight size={13} aria-hidden />
        </Link>
      </div>
    </li>
  );
}

/** A short, honest tour: every step opens the real product, nothing is pre-recorded. */
export default async function GuidePage() {
  const user = await requireUser();
  const s = await homeSnapshot(user.workspaceId);
  const flow = s.cloudFlowId ? `/flows/${s.cloudFlowId}` : "/flows";
  return (
    <>
      <PageHeader
        title="Demo guide"
        lead="About five minutes. Every step opens the real product — the AI compiler, the decision engine, the approvals queue and the audit trail. Steps 1 and 2 are enough to understand PayFlow; nothing here moves money unless you approve a payment."
      />
      <ol className="max-w-5xl">
        <Step n={1} title="Create a workflow with AI" minutes="~1 min" href={`/flows?instruction=${encodeURIComponent(TRY_EXAMPLES[0].instruction)}#compile-h`} cta="Open the compiler">
          <p>
            Use: <span className="text-ink">“{TRY_EXAMPLES[0].instruction}”</span>
          </p>
          <p>The model drafts a graph; PayFlow validates it and saves it as a draft. It cannot activate anything — a person does that.</p>
        </Step>
        <Step n={2} title="Test it safely" minutes="~1 min" href={`${flow}?test=1`} cta="Test Cloud procurement">
          <p>
            On <span className="text-ink">Cloud procurement</span>, press <span className="text-ink">Test this flow</span> and use the examples: <span className="text-ink">$185 Acme Cloud, GPU compute</span> → allowed; then{" "}
            <span className="text-ink">$470 Acme Cloud, digital gift cards</span> → a person must approve.
          </p>
          <p>Test runs use the real decision engine. PayPal is not contacted and no budget is reserved.</p>
        </Step>
        <Step n={3} title="See why the gift cards stopped" minutes="~30 s" href="/authority" cta="Read the authority">
          <p>
            In the test result, the supplier, currency, amount and budget all pass — but <span className="text-ink">Purpose</span> fails: gift cards are not cloud infrastructure. The authority page says, in one sentence, what this workflow may pay for.
          </p>
        </Step>
        <Step n={4} title="An AI agent asks" minutes="~1 min" href={s.demoAgentId ? `/agents/${s.demoAgentId}` : "/agents"} cta="Open the agent">
          <p>
            The <span className="text-ink">Cloud Procurement Agent</span> may <em>ask</em> for payouts through Cloud procurement. It cannot approve, change its authority or workflow, or reach PayPal. Its requests arrive through PayFlow&rsquo;s MCP server and get the same checks as everything else.
          </p>
        </Step>
        <Step n={5} title="A person approves once" minutes="~1 min" href={s.pending > 0 ? "/approvals" : `${flow}?test=1`} cta={s.pending > 0 ? "Open approvals" : "Test the $650 request"}>
          <p>
            A <span className="text-ink">$650 AWS GPU compute</span> request exceeds the $500 delegated limit by $150, so it waits for a person. <span className="text-ink">Approve once</span> covers that single request; it never raises the limit.
          </p>
          {s.pending === 0 && (
            <p>
              Nothing is waiting right now (requests for a person expire after 24 hours). See the same decision with the <span className="text-ink">$650 · AWS</span> example in Test this flow, then press <span className="text-ink">Assume approved</span> to follow the rest of the path — inside the test only.
            </p>
          )}
        </Step>
        <Step n={6} title="Check the record" minutes="~30 s" href="/audit" cta="Open the audit trail">
          <p>
            Every agent request has an <span className="text-ink">Intent Receipt</span> — who asked, for what, how much, to whom, why — with an integrity check, and every decision is in a hash-chained audit trail.
          </p>
        </Step>
      </ol>
      <p className="mt-6 max-w-3xl text-body-sm text-muted">
        Everything runs against PayPal&rsquo;s Sandbox — no real money. Records are labelled by where they came from: Real PayPal Sandbox, real or cached OpenAI analysis, Test run, and Demo setup.
      </p>
    </>
  );
}
