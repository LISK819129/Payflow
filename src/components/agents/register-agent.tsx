"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { registerAgentAction } from "@/app/(app)/agents/actions";
import { Button, Field } from "@/components/ui";
import { OneTimeToken } from "./one-time-token";

type Option = { id: string; name: string; actions: ("paypal.payout" | "paypal.refund")[] };

/** Owner registers an agent: a name, what it may ASK for, and an optional expiry. */
export function RegisterAgent({ workflows, preselect }: { workflows: Option[]; /** From "Connect an AI agent" on a workflow: open the form with it chosen. */ preselect?: string }) {
  const router = useRouter();
  const chosen = preselect ? workflows.find((w) => w.id === preselect) : undefined;
  const [open, setOpen] = useState(!!chosen);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Record<string, { actions: string[]; live: boolean; test: boolean }>>(chosen ? { [chosen.id]: { actions: [chosen.actions[0]], live: true, test: true } } : {});
  const [days, setDays] = useState<number | null>(90);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ token: string; id: string } | null>(null);
  const [pending, start] = useTransition();

  if (token) return <OneTimeToken token={token.token} onDone={() => router.push(`/agents/${token.id}`)} />;
  if (!open)
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden /> Register an agent
      </Button>
    );

  const toggle = (id: string, action?: string) =>
    setPicked((p) => {
      const cur = p[id];
      if (!action) {
        if (cur) {
          const { [id]: _drop, ...rest } = p;
          void _drop;
          return rest;
        }
        const w = workflows.find((x) => x.id === id)!;
        return { ...p, [id]: { actions: [w.actions[0]], live: true, test: true } };
      }
      const actions = cur.actions.includes(action) ? cur.actions.filter((a) => a !== action) : [...cur.actions, action];
      return { ...p, [id]: { ...cur, actions } };
    });

  const submit = () =>
    start(async () => {
      setError(null);
      const scopes = Object.entries(picked).map(([workflowId, v]) => ({
        workflowId,
        actions: v.actions as ("paypal.payout" | "paypal.refund")[],
        modes: [...(v.live ? ["LIVE" as const] : []), ...(v.test ? ["TEST" as const] : [])],
      }));
      const r = await registerAgentAction({ name, description, scopes, expiresInDays: days });
      if (r.ok && r.token && r.id) setToken({ token: r.token, id: r.id });
      else if (!r.ok) setError(r.error);
    });

  return (
    <section className="border-t-2 border-ink bg-surface px-6 py-6" aria-label="Register an agent">
      <h2 className="text-title font-semibold">Register an agent</h2>
      <p className="mt-1 max-w-2xl text-body-sm text-muted">
        An agent gets its own identity and may only <em>ask</em>. Whether money moves is decided by the workflow&rsquo;s authority, PayFlow&rsquo;s intelligence and, when needed, a person. It never inherits your permissions.
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Field id="agent-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cloud Procurement Agent" />
        <Field id="agent-desc" label="What it does (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Pays cloud suppliers' invoices" />
      </div>

      <fieldset className="mt-8">
        <legend className="pf-label">May request through</legend>
        {workflows.length === 0 && <p className="mt-2 text-body-sm text-muted">No active workflow accepts agent requests yet. Give a workflow an “Agent request” trigger and activate it.</p>}
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {workflows.map((w) => {
            const p = picked[w.id];
            return (
              <li key={w.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                <label className="flex min-w-56 items-center gap-2 text-body font-medium">
                  <input type="checkbox" checked={!!p} onChange={() => toggle(w.id)} className="size-4 accent-ink" />
                  {w.name}
                </label>
                {p && (
                  <>
                    {w.actions.map((a) => (
                      <label key={a} className="flex items-center gap-1.5 text-body-sm">
                        <input type="checkbox" checked={p.actions.includes(a)} onChange={() => toggle(w.id, a)} className="size-3.5 accent-ink" />
                        {a.replace("paypal.", "")}
                      </label>
                    ))}
                    <span className="text-faint">·</span>
                    <label className="flex items-center gap-1.5 text-body-sm">
                      <input type="checkbox" checked={p.live} onChange={() => setPicked({ ...picked, [w.id]: { ...p, live: !p.live } })} className="size-3.5 accent-ink" /> live requests
                    </label>
                    <label className="flex items-center gap-1.5 text-body-sm">
                      <input type="checkbox" checked={p.test} onChange={() => setPicked({ ...picked, [w.id]: { ...p, test: !p.test } })} className="size-3.5 accent-ink" /> test requests
                    </label>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <label className="mt-6 block max-w-xs">
        <span className="pf-label">Access expires</span>
        <select value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)} className="mt-1.5 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none">
          <option value="30">in 30 days</option>
          <option value="90">in 90 days</option>
          <option value="365">in a year</option>
          <option value="">never (until revoked)</option>
        </select>
      </label>

      {error && <p className="mt-4 text-body-sm text-danger">{error}</p>}
      <div className="mt-6 flex gap-2">
        <Button variant="primary" onClick={submit} disabled={pending || !name.trim() || !Object.keys(picked).length}>
          {pending ? "Registering…" : "Register and issue credential"}
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
