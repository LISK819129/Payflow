"use client";

import { FlaskConical } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { testRunAction } from "@/app/(app)/simulations/actions";
import { Button } from "@/components/ui";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";

type Field = { key: string; kind: "money" | "text" | "long" };

const LONG = /invoice|contract|description|note|purpose|bill|memo|details/i;

/** Fields the graph reads from `trigger.*`, typed by how they are used. */
function fieldsFor(graph: WorkflowGraph): Field[] {
  const out = new Map<string, Field["kind"]>();
  const visit = (v: unknown, prop: string) => {
    if (typeof v === "string") {
      const m = /^trigger\.([A-Za-z0-9_]+)/.exec(v);
      if (m && !out.has(m[1])) out.set(m[1], /amount|payment/i.test(prop) && !/ref$/i.test(m[1]) ? "money" : LONG.test(m[1]) ? "long" : "text");
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, prop));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => visit(x, k));
  };
  graph.nodes.forEach((n) => visit(n.config, ""));
  return [...out].map(([key, kind]) => ({ key, kind }));
}

const input = "mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink";

export function TestRunDialog({ workflowId, graph, onClose }: { workflowId: string; graph: WorkflowGraph; onClose: () => void }) {
  const router = useRouter();
  const trigger = graph.nodes.find((n) => n.type.startsWith("trigger."));
  const isEvent = trigger?.type === "trigger.paypal_event";
  const eventTypes = (trigger?.config as { eventTypes?: string[] } | undefined)?.eventTypes ?? [];
  const fields = useMemo(() => fieldsFor(graph).filter((f) => !(isEvent && ["amount", "payer", "resourceId", "invoiceId", "eventType", "resource"].includes(f.key))), [graph, isEvent]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [money, setMoney] = useState<Record<string, { value: string; currency: string }>>({});
  const [event, setEvent] = useState({ eventType: eventTypes[0] ?? "", amount: "", currency: "USD", payer: "", resourceId: "", invoiceId: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const build = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.kind === "money") {
        const m = money[f.key];
        if (m?.value) p[f.key] = { value: m.value.trim(), currency_code: (m.currency || "USD").trim().toUpperCase() };
      } else if (values[f.key]) p[f.key] = values[f.key];
    }
    if (!isEvent) return p;
    // Shaped like a normalised PayPal event, but labelled as test input everywhere.
    return {
      ...p,
      kind: "paypal_event",
      eventId: "TEST-INPUT",
      eventType: event.eventType,
      resourceType: null,
      resourceId: event.resourceId || null,
      summary: "Test input — not a PayPal event",
      amount: event.amount ? { value: event.amount.trim(), currency_code: event.currency.trim().toUpperCase() } : null,
      payer: { email: event.payer || null, payerId: null, name: null },
      invoiceId: event.invoiceId || null,
      orderId: null,
      resource: {},
    };
  };

  const run = () =>
    start(async () => {
      setError(null);
      const r = await testRunAction(workflowId, JSON.stringify(build()));
      if (r.ok) router.push(`/simulations/${r.id}`);
      else setError(r.error);
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4" role="dialog" aria-modal="true" aria-labelledby="test-title">
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-lg border border-line bg-surface p-6 shadow-pop">
        <h2 id="test-title" className="inline-flex items-center gap-2 text-title font-semibold">
          <FlaskConical size={18} aria-hidden /> Test this flow
        </h2>
        <p className="mt-1 text-body-sm text-muted">See exactly how this workflow handles a transaction — without moving money. PayPal is never contacted and no budget is reserved.</p>
        <div className="mt-4 inline-block rounded-sm border border-line-strong px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] text-muted">Test input — user provided</div>

        <div className="mt-4 space-y-4">
          {isEvent && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="pf-label">Event type</span>
                <select aria-label="Event type" className={input} value={event.eventType} onChange={(e) => setEvent({ ...event, eventType: e.target.value })}>
                  {eventTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="pf-label">Amount</span>
                <input aria-label="Amount" className={input} inputMode="decimal" value={event.amount} onChange={(e) => setEvent({ ...event, amount: e.target.value })} placeholder="120.00" />
              </label>
              <label className="block">
                <span className="pf-label">Currency</span>
                <input aria-label="Currency" className={input} value={event.currency} onChange={(e) => setEvent({ ...event, currency: e.target.value })} />
              </label>
              <label className="block">
                <span className="pf-label">Payer email</span>
                <input aria-label="Payer email" className={input} value={event.payer} onChange={(e) => setEvent({ ...event, payer: e.target.value })} />
              </label>
              <label className="block">
                <span className="pf-label">Resource id</span>
                <input aria-label="Resource id" className={`${input} font-mono`} value={event.resourceId} onChange={(e) => setEvent({ ...event, resourceId: e.target.value })} />
              </label>
            </div>
          )}
          {fields.map((f) =>
            f.kind === "money" ? (
              <div key={f.key} className="grid grid-cols-[1fr_96px] gap-4">
                <label className="block">
                  <span className="pf-label">{f.key}</span>
                  <input aria-label={f.key} className={input} inputMode="decimal" value={money[f.key]?.value ?? ""} onChange={(e) => setMoney({ ...money, [f.key]: { value: e.target.value, currency: money[f.key]?.currency ?? "USD" } })} placeholder="180.00" />
                </label>
                <label className="block">
                  <span className="pf-label">Currency</span>
                  <input aria-label={`${f.key} currency`} className={input} value={money[f.key]?.currency ?? "USD"} onChange={(e) => setMoney({ ...money, [f.key]: { value: money[f.key]?.value ?? "", currency: e.target.value } })} />
                </label>
              </div>
            ) : (
              <label key={f.key} className="block">
                <span className="pf-label">{f.key}</span>
                {f.kind === "long" ? (
                  <textarea aria-label={f.key} className={`${input} h-28 font-mono text-meta`} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                ) : (
                  <input aria-label={f.key} className={input} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                )}
              </label>
            ),
          )}
        </div>

        {error && <p className="mt-3 text-body-sm text-danger">{error}</p>}
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={pending}>
            <FlaskConical size={14} aria-hidden /> {pending ? "Testing…" : "Run test"}
          </Button>
        </div>
      </div>
    </div>
  );
}
