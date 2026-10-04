"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { createAuthorityAction, updateAuthorityAction } from "./actions";

export type AuthorityFormValue = {
  name: string;
  description: string;
  workflowIds: string[];
  actions: string[];
  counterpartyRule: "allowlist" | "any";
  counterparties: string;
  denied: string;
  currencies: string;
  perTransactionMax: string;
  budgetAmount: string;
  budgetPeriod: "" | "day" | "week" | "month";
  maxCount: string;
  countPeriod: "" | "hour" | "day" | "week" | "month";
  validFrom: string;
  expiresAt: string;
};

const ACTIONS: [string, string][] = [
  ["paypal.payout", "Payout"],
  ["paypal.refund", "Refund"],
  ["paypal.order_capture", "Order capture"],
  ["paypal.invoice_send", "Send invoice"],
  ["paypal.invoice_remind", "Invoice reminder"],
];

/** "billing@acme.example, Acme Cloud" per line → {id, name}. */
const parties = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, ...name] = l.split(",");
      return { id: id.trim(), ...(name.join(",").trim() ? { name: name.join(",").trim() } : {}) };
    });

const input = "mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink";

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="pf-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-meta text-muted">{hint}</span>}
    </label>
  );
}

export function AuthorityForm({ id, initial, workflows }: { id?: string; initial: AuthorityFormValue; workflows: { id: string; name: string }[] }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<AuthorityFormValue>) => setV((x) => ({ ...x, ...patch }));
  const toggle = (key: "workflowIds" | "actions", value: string) => set({ [key]: v[key].includes(value) ? v[key].filter((x) => x !== value) : [...v[key], value] } as Partial<AuthorityFormValue>);

  const submit = () =>
    start(async () => {
      const data = {
        name: v.name,
        description: v.description || undefined,
        workflowIds: v.workflowIds,
        actions: v.actions,
        counterpartyRule: v.counterpartyRule,
        counterparties: parties(v.counterparties),
        deniedCounterparties: parties(v.denied),
        currencies: v.currencies
          .split(/[\s,]+/)
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
        perTransactionMax: v.perTransactionMax.trim() || null,
        budgetAmount: v.budgetAmount.trim() || null,
        budgetPeriod: v.budgetPeriod || null,
        maxCount: v.maxCount.trim() ? Number(v.maxCount) : null,
        countPeriod: v.countPeriod || null,
        validFrom: v.validFrom ? `${v.validFrom}T00:00:00Z` : null,
        expiresAt: v.expiresAt ? `${v.expiresAt}T23:59:59Z` : null,
      };
      const r = id ? await updateAuthorityAction(id, data) : await createAuthorityAction(data);
      if (!r.ok) setError(r.error);
      else router.push("/authority");
    });

  return (
    <div className="max-w-3xl space-y-10">
      <section className="grid gap-6 sm:grid-cols-2">
        <L label="Name">
          <input className={input} value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Cloud procurement" />
        </L>
        <L label="Description (optional)">
          <input className={input} value={v.description} onChange={(e) => set({ description: e.target.value })} />
        </L>
      </section>

      <fieldset>
        <legend className="pf-label">Who — workflows that may use this authority</legend>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {workflows.map((w) => (
            <label key={w.id} className="flex items-center gap-2 text-body">
              <input type="checkbox" checked={v.workflowIds.includes(w.id)} onChange={() => toggle("workflowIds", w.id)} className="accent-[var(--pf-ink)]" />
              {w.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="pf-label">What — PayPal actions it permits</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          {ACTIONS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-body">
              <input type="checkbox" checked={v.actions.includes(k)} onChange={() => toggle("actions", k)} className="accent-[var(--pf-ink)]" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="pf-label">To whom</legend>
        <div className="flex gap-6 text-body">
          <label className="flex items-center gap-2">
            <input type="radio" name="rule" checked={v.counterpartyRule === "allowlist"} onChange={() => set({ counterpartyRule: "allowlist" })} /> Only these counterparties
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="rule" checked={v.counterpartyRule === "any"} onChange={() => set({ counterpartyRule: "any" })} /> Anyone not denied
          </label>
        </div>
        {v.counterpartyRule === "allowlist" && (
          <L label="Allowed — one per line: email, name" hint="Anyone else goes to a person for review.">
            <textarea className={`${input} h-24 font-mono text-meta`} value={v.counterparties} onChange={(e) => set({ counterparties: e.target.value })} placeholder={"billing@acme-cloud.example, Acme Cloud"} />
          </L>
        )}
        <L label="Never pay — one per line: email, name" hint="Always refused, even with approval.">
          <textarea className={`${input} h-16 font-mono text-meta`} value={v.denied} onChange={(e) => set({ denied: e.target.value })} />
        </L>
      </fieldset>

      <section className="grid gap-6 sm:grid-cols-3">
        <L label="Currencies" hint="Limits are in the first one; no FX.">
          <input className={input} value={v.currencies} onChange={(e) => set({ currencies: e.target.value })} />
        </L>
        <L label="Per transaction (max)" hint="Larger requests go to a person.">
          <input className={input} inputMode="decimal" value={v.perTransactionMax} onChange={(e) => set({ perTransactionMax: e.target.value })} placeholder="500" />
        </L>
        <div />
        <L label="Budget" hint="Spent + reserved in the period, exact.">
          <input className={input} inputMode="decimal" value={v.budgetAmount} onChange={(e) => set({ budgetAmount: e.target.value })} placeholder="2000" />
        </L>
        <L label="per">
          <select className={input} value={v.budgetPeriod} onChange={(e) => set({ budgetPeriod: e.target.value as AuthorityFormValue["budgetPeriod"] })}>
            <option value="">—</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </L>
        <div />
        <L label="Max actions">
          <input className={input} inputMode="numeric" value={v.maxCount} onChange={(e) => set({ maxCount: e.target.value })} />
        </L>
        <L label="per">
          <select className={input} value={v.countPeriod} onChange={(e) => set({ countPeriod: e.target.value as AuthorityFormValue["countPeriod"] })}>
            <option value="">—</option>
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </L>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        <L label="Valid from (UTC)">
          <input type="date" className={input} value={v.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
        </L>
        <L label="Expires (end of day, UTC)">
          <input type="date" className={input} value={v.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
        </L>
      </section>

      <div className="flex items-center gap-3 border-t border-line pt-6">
        <Button variant="primary" onClick={submit} disabled={pending}>
          {id ? "Save as a new version" : "Create authority"}
        </Button>
        <Button variant="quiet" onClick={() => router.push("/authority")}>
          Cancel
        </Button>
        <span className="text-meta text-muted">Recorded in the audit trail{id ? "; requests already decided keep the version they were decided under" : ""}.</span>
      </div>
      {error && <p className="text-body-sm text-danger">{error}</p>}
    </div>
  );
}
