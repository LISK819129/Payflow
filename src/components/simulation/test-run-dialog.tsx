"use client";

import { FlaskConical } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { testRunAction } from "@/app/(app)/simulations/actions";
import { Button } from "@/components/ui";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { emptyFields, fieldLabel, fieldsFor, manualPayload, RESULT_NAVIGATION_FALLBACK_MS, TEST_RUN_WAIT_MS, withTimeout, type MoneyInput } from "./test-input";

const input = "mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink";

const SUPPLIER_KEYS = new Set(["counterparty", "supplierEmail"]);

export function TestRunDialog({
  workflowId,
  graph,
  onClose,
  suppliers = [],
  examples = [],
}: {
  workflowId: string;
  graph: WorkflowGraph;
  onClose: () => void;
  /** Recipients the covering authority names — offered as choices for the supplier field. */
  suppliers?: { id: string; name: string }[];
  /** Input presets only; the verdict always comes from the engine. */
  examples?: { label: string; values: Record<string, string | { value: string; currency_code: string }> }[];
}) {
  const router = useRouter();
  const trigger = graph.nodes.find((n) => n.type.startsWith("trigger."));
  const isEvent = trigger?.type === "trigger.paypal_event";
  const eventTypes = (trigger?.config as { eventTypes?: string[] } | undefined)?.eventTypes ?? [];
  const fields = useMemo(() => fieldsFor(graph).filter((f) => !(isEvent && ["amount", "payer", "resourceId", "invoiceId", "eventType", "resource"].includes(f.key))), [graph, isEvent]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [money, setMoney] = useState<Record<string, MoneyInput>>({});
  const [event, setEvent] = useState({ eventType: eventTypes[0] ?? "", amount: "", currency: "USD", payer: "", resourceId: "", invoiceId: "" });
  const [error, setError] = useState<string | null>(null);
  // idle → running (waiting for PayFlow) → opening (result saved, navigating). Never stuck: see run().
  const [phase, setPhase] = useState<"idle" | "running" | "opening">("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // Empty fields the person has already been told about; a second press tests them as missing.
  const [acceptedEmpty, setAcceptedEmpty] = useState<string | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (fallback.current) clearTimeout(fallback.current);
  }, []);

  const build = (): Record<string, unknown> => {
    const p = manualPayload(fields, values, money);
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

  const missing = isEvent ? [] : emptyFields(fields, values, money);

  const run = async () => {
    if (phase !== "idle") return;
    // An empty field is a legitimate test ("what if the amount is missing?"), but never a silent one.
    const key = missing.join(",");
    if (missing.length && acceptedEmpty !== key) {
      setAcceptedEmpty(key);
      setError(`${missing.map(fieldLabel).join(", ")} ${missing.length === 1 ? "is" : "are"} empty. This flow reads ${missing.length === 1 ? "it" : "them"}, so the test will treat ${missing.length === 1 ? "it" : "them"} as missing. Fill ${missing.length === 1 ? "it" : "them"} in, or press Run test again to test that.`);
      return;
    }
    setError(null);
    setPhase("running");
    let r: Awaited<ReturnType<typeof testRunAction>> | "timeout";
    try {
      r = await withTimeout(testRunAction(workflowId, JSON.stringify(build())), TEST_RUN_WAIT_MS);
    } catch (e) {
      setPhase("idle");
      setError(`The test could not be run (${(e as Error).message || "no answer from the server"}). Nothing was sent to PayPal. Try again.`);
      return;
    }
    if (r === "timeout") {
      setPhase("idle");
      setError(`No answer from PayFlow after ${TEST_RUN_WAIT_MS / 1000} seconds. Nothing was sent to PayPal and no budget was reserved — a test never does. Try again; if it keeps happening, check that the app is running.`);
      return;
    }
    if (!r.ok) {
      setPhase("idle");
      setError(r.error);
      return;
    }
    const url = `/simulations/${r.id}`;
    setResultUrl(url);
    setPhase("opening");
    router.push(url);
    // If the in-app navigation stalls, load the saved result directly. A full page load is the point
    // here: it does not depend on the client router that failed to finish.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    fallback.current = setTimeout(() => window.location.assign(url), RESULT_NAVIGATION_FALLBACK_MS);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4" role="dialog" aria-modal="true" aria-labelledby="test-title">
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-lg border border-line bg-surface p-6 shadow-pop">
        <h2 id="test-title" className="inline-flex items-center gap-2 text-title font-semibold">
          <FlaskConical size={18} aria-hidden /> Test run
        </h2>
        <p className="mt-1 text-body-sm text-muted">See what PayFlow would decide for a request — with the real rules — without contacting PayPal. Nothing is paid and no budget is reserved.</p>
        <div className="mt-4 inline-block rounded-sm border border-line-strong px-1.5 py-px text-label font-semibold uppercase tracking-[0.06em] text-muted">Test input — user provided</div>
        {examples.length > 0 && (
          <div className="mt-4">
            <div className="pf-label">Fill in an example</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {examples.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => {
                    const v: Record<string, string> = {};
                    const m: Record<string, { value: string; currency: string }> = {};
                    for (const [k, x] of Object.entries(ex.values)) {
                      if (typeof x === "string") v[k] = x;
                      else m[k] = { value: x.value, currency: x.currency_code };
                    }
                    setValues(v);
                    setMoney(m);
                  }}
                  className="rounded-sm border border-line px-2 py-1 text-body-sm text-ink-2 hover:border-ink hover:text-ink"
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-meta text-muted">Examples only fill the form. The result comes from the real decision engine.</p>
          </div>
        )}

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
                <input aria-label="Amount" className={input} inputMode="decimal" value={event.amount} onChange={(e) => setEvent({ ...event, amount: e.target.value })} />
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
                  <span className="pf-label">{fieldLabel(f.key)}</span>
                  <input aria-label={fieldLabel(f.key)} className={input} inputMode="decimal" value={money[f.key]?.value ?? ""} onChange={(e) => setMoney({ ...money, [f.key]: { value: e.target.value, currency: money[f.key]?.currency ?? "USD" } })} />
                </label>
                <label className="block">
                  <span className="pf-label">Currency</span>
                  <input aria-label={`${fieldLabel(f.key)} currency`} className={input} value={money[f.key]?.currency ?? "USD"} onChange={(e) => setMoney({ ...money, [f.key]: { value: money[f.key]?.value ?? "", currency: e.target.value } })} />
                </label>
              </div>
            ) : SUPPLIER_KEYS.has(f.key) && suppliers.length > 0 ? (
              <label key={f.key} className="block">
                <span className="pf-label">{fieldLabel(f.key)}</span>
                <select aria-label={fieldLabel(f.key)} className={input} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                  <option value="">Choose…</option>
                  {suppliers.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name} · {sp.id}
                    </option>
                  ))}
                  {values[f.key] && !suppliers.some((sp) => sp.id === values[f.key]) && <option value={values[f.key]}>{values[f.key]}</option>}
                </select>
                <input aria-label={`${fieldLabel(f.key)} (other)`} className={`${input} mt-2 font-mono text-meta`} placeholder="or another PayPal email" value={suppliers.some((sp) => sp.id === values[f.key]) ? "" : (values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              </label>
            ) : (
              <label key={f.key} className="block">
                <span className="pf-label">{fieldLabel(f.key)}</span>
                {f.kind === "long" ? (
                  <textarea aria-label={fieldLabel(f.key)} className={`${input} h-28 font-mono text-meta`} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                ) : (
                  <input aria-label={fieldLabel(f.key)} className={input} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                )}
              </label>
            ),
          )}
        </div>

        {error && (
          <p className="mt-3 text-body-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {resultUrl && (
          <p className="mt-3 text-body-sm text-ink-2" role="status">
            Test finished.{" "}
            <Link href={resultUrl} className="font-medium text-ink underline underline-offset-4">
              Open the result
            </Link>
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={phase !== "idle"}>
            <FlaskConical size={14} aria-hidden /> {phase === "running" ? "Testing…" : phase === "opening" ? "Opening result…" : "Run test"}
          </Button>
        </div>
      </div>
    </div>
  );
}
