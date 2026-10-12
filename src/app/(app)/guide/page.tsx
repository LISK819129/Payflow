import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { agentRequests } from "@/server/db/schema";
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

/** One story, eight steps: every step opens the real product; nothing is pre-recorded. */
export default async function GuidePage() {
  const user = await requireUser();
  const s = await homeSnapshot(user.workspaceId);
  const flow = s.cloudFlowId ? `/flows/${s.cloudFlowId}` : "/flows";
  // The newest agent request that reached PayPal — its Intent Receipt is step 7.
  const [paid] = await db()
    .select({ reference: agentRequests.reference })
    .from(agentRequests)
    .where(and(eq(agentRequests.workspaceId, user.workspaceId), inArray(agentRequests.state, ["SUBMITTED_TO_PAYPAL", "AWAITING_RECIPIENT", "COMPLETED"])))
    .orderBy(desc(agentRequests.createdAt))
    .limit(1);
  const receipt = paid ? `/agents/requests/${paid.reference}` : s.demoAgentId ? `/agents/${s.demoAgentId}` : "/agents";
  return (
    <>
      <PageHeader
        title="Demo guide"
        lead="One story, about three minutes. An AI agent asks to spend money; PayFlow checks each request against the authority it was given; a person decides only the exceptions; PayPal moves the money; a receipt proves what happened. Every step opens the real product."
      />
      <ol className="max-w-5xl">
        <Step n={1} title="What PayFlow is" minutes="~20 s" href="/" cta="Home">
          <p>
            AI agents get <span className="text-ink">permission to ask</span> for payments — not PayPal credentials. The Cloud Procurement Agent may ask to pay Acme Cloud and AWS, in USD, up to $500 each, for cloud infrastructure.
          </p>
        </Step>
        <Step n={2} title="A request inside its authority" minutes="~30 s" href={`${flow}?test=1`} cta="Try the $185 request">
          <p>
            In <span className="text-ink">Try a request</span>, pick <span className="text-ink">$185 · Acme Cloud · GPU compute</span> → <span className="text-ink">Run test</span>. Supplier, currency, amount, budget and purpose all pass: it would be paid without anyone.
          </p>
          <p>A test uses the real decision engine. PayPal is not contacted, nothing is paid and no budget is reserved.</p>
        </Step>
        <Step n={3} title="Outside the purpose it was given" minutes="~30 s" href={`${flow}?test=1`} cta="Try the $470 request">
          <p>
            Pick <span className="text-ink">$470 · Acme Cloud · digital gift cards</span>. Supplier ✓ Currency ✓ Amount ✓ Budget ✓ — but <span className="text-ink">Purpose ✕</span>: the request says it is for gift cards, and this agent was authorized only for cloud infrastructure. A person decides.
          </p>
        </Step>
        <Step n={4} title="Over the limit: approve once" minutes="~40 s" href={s.pending > 0 ? "/approvals" : `${flow}?test=1`} cta={s.pending > 0 ? "Open approvals" : "Try the $650 request"}>
          <p>
            <span className="text-ink">$650 · AWS · GPU compute</span> is $150 over the agent&rsquo;s $500 limit, so it waits for a person. <span className="text-ink">Approve once</span> covers that one request — the authority does not change. <span className="text-ink">$120 · Blocked Vendor</span> is refused outright.
          </p>
          {s.pending === 0 ? (
            <p>Nothing is waiting right now (a request for a person expires after 24 hours): run the $650 example and press <span className="text-ink">Assume approved</span> to follow the rest of the path inside the test.</p>
          ) : (
            <p>Approving a live request sends a real PayPal Sandbox payout (test money). Reject it if you only want to look.</p>
          )}
        </Step>
        <Step n={5} title="The agent can only ask" minutes="~20 s" href={s.demoAgentId ? `/agents/${s.demoAgentId}` : "/agents"} cta="Open the agent">
          <p>
            The Cloud Procurement Agent has an identity, an owner and an expiry. It <span className="text-ink">can request</span> payouts through Cloud procurement; it <span className="text-ink">can never</span> approve, change its authority, call PayPal or see a credential. Revoking it refuses its next call.
          </p>
        </Step>
        <Step n={6} title="PayPal moves the money" minutes="~20 s" href="/events" cta="PayPal events">
          <p>
            Allowed requests are sent to the <span className="text-ink">PayPal Sandbox</span>. PayPal&rsquo;s signed webhooks are verified and confirmed with PayPal before PayFlow trusts them — status comes from PayPal (<span className="text-ink">Submitted</span>, <span className="text-ink">Settled</span>, <span className="text-ink">Awaiting recipient</span>), never assumed.
          </p>
        </Step>
        <Step n={7} title="The Intent Receipt" minutes="~30 s" href={receipt} cta="Open a receipt">
          <p>
            Every agent request has a receipt: who asked, what, how much, to whom, why, under which authority version, whether a person decided — and what PayPal reported. Its integrity is checked every time it is shown.
          </p>
        </Step>
        <Step n={8} title="The audit trail" minutes="~20 s" href={paid ? `/audit?q=${paid.reference}` : "/audit"} cta="Search the audit trail">
          <p>Every decision, approval and PayPal response is in a tamper-evident, hash-chained log. Search a request&rsquo;s reference to see its whole trail.</p>
        </Step>
      </ol>
      <div className="mt-10 max-w-5xl border-t border-line pt-6">
        <h2 className="pf-label">Also</h2>
        <p className="mt-2 text-body text-ink-2">
          <Link href={`/flows?instruction=${encodeURIComponent(TRY_EXAMPLES[0].instruction)}#compile-h`} className="text-ink underline underline-offset-4">
            Write a payment rule in plain English
          </Link>{" "}
          — the AI drafts a workflow, PayFlow validates it, a person activates it. Its authority still bounds what it may pay.
        </p>
      </div>
      <p className="mt-6 max-w-3xl text-body-sm text-muted">
        Everything runs against PayPal&rsquo;s Sandbox — no real money. Records are labelled by where they came from: Real PayPal Sandbox, real or cached OpenAI analysis, Test run, and Demo setup.
      </p>
    </>
  );
}
