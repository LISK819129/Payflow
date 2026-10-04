"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { describeExpr, type Expr } from "@/server/workflow/dsl/expression";
import { SPEC_BY_TYPE, type GraphNode } from "@/server/workflow/dsl/nodes";
import type { Issue } from "@/server/workflow/dsl/validate";

type Props = {
  node: GraphNode;
  issues: Issue[];
  readOnly: boolean;
  onChange: (n: GraphNode) => void;
  onDelete: () => void;
};

const inputCls =
  "mt-1 block w-full rounded-sm border border-field bg-surface px-2 py-1.5 text-body-sm text-ink outline-none focus:border-ink focus-visible:shadow-[0_0_0_3px_var(--pf-marker-wash)] disabled:bg-sunken disabled:text-muted";

function Text({ label, value, onChange, mono, placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="pf-label">{label}</span>
      <input className={`${inputCls} ${mono ? "font-mono" : ""}`} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(", ") : "");
const toList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

/**
 * Edits one node's config. Structured fields for common node types; every type
 * also has a raw JSON editor. Validation happens on the whole graph, so this
 * component only shapes values, it never decides whether they're acceptable.
 */
export function Inspector({ node, issues, readOnly, onChange, onDelete }: Props) {
  const spec = SPEC_BY_TYPE[node.type];
  const c = node.config as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => {
    const next = { ...c, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange({ ...node, config: next });
  };
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <div>
        <div className="pf-label">{spec.category}</div>
        <div className="mt-0.5 text-lead font-semibold">{spec.title}</div>
        <p className="mt-1 text-body-sm text-muted">{spec.description}</p>
        <div className="mt-1 font-mono text-meta text-faint">id {node.id}</div>
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1 border-l-2 border-danger pl-3">
          {issues.map((i, k) => (
            <li key={k} className={`text-body-sm ${i.severity === "error" ? "text-danger" : "text-warn"}`}>
              {i.message}
            </li>
          ))}
        </ul>
      )}

      <fieldset disabled={readOnly} className="space-y-4">
        <Text label="Label" value={node.label ?? ""} onChange={(v) => onChange({ ...node, label: v || undefined })} />

        {node.type === "trigger.paypal_event" && (
          <Text label="PayPal event types" mono value={list(c.eventTypes)} onChange={(v) => set({ eventTypes: toList(v) })} placeholder="PAYMENT.CAPTURE.COMPLETED" />
        )}
        {node.type === "trigger.schedule" && (
          <>
            <Text label="Cron" mono value={String(c.cron ?? "")} onChange={(v) => set({ cron: v })} placeholder="0 9 * * 1" />
            <Text label="Timezone" value={String(c.timezone ?? "UTC")} onChange={(v) => set({ timezone: v })} />
          </>
        )}
        {node.type === "control.condition" && <ConditionEditor expr={c.expr as Expr | undefined} onChange={(expr) => set({ expr })} />}
        {node.type === "control.approval" && (
          <>
            <Text label="Reason shown to the approver" value={String(c.reason ?? "")} onChange={(v) => set({ reason: v })} />
            <Text label="Amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <Text label="Counterparty (reference)" mono value={String(c.counterpartyRef ?? "")} onChange={(v) => set({ counterpartyRef: v })} placeholder="trigger.payer.email" />
            <Text label="Expires after (hours)" value={c.expiresAfterHours === undefined ? "" : String(c.expiresAfterHours)} onChange={(v) => set({ expiresAfterHours: num(v) })} />
          </>
        )}
        {node.type === "control.delay" && (
          <>
            <Text label="Wait minutes" value={c.minutes === undefined ? "" : String(c.minutes)} onChange={(v) => set({ minutes: num(v) })} />
            <Text label="…or until date (reference)" mono value={String(c.untilRef ?? "")} onChange={(v) => set({ untilRef: v })} placeholder="trigger.dueDate" />
            <Text label="Offset days" value={c.offsetDays === undefined ? "" : String(c.offsetDays)} onChange={(v) => set({ offsetDays: num(v) })} />
          </>
        )}
        {node.type === "control.freeze" && (
          <>
            <Text label="Reason" value={String(c.reason ?? "")} onChange={(v) => set({ reason: v })} />
            <label className="flex items-center gap-2 text-body-sm">
              <input type="checkbox" checked={c.includeDependents !== false} onChange={(e) => set({ includeDependents: e.target.checked })} />
              Also freeze workflows that depend on this one
            </label>
          </>
        )}
        {node.type === "control.terminal" && (
          <>
            <label className="block">
              <span className="pf-label">Outcome</span>
              <select className={inputCls} value={String(c.outcome ?? "completed")} onChange={(e) => set({ outcome: e.target.value })}>
                {["completed", "blocked", "rejected", "needs_review"].map((o) => (
                  <option key={o} value={o}>
                    {o.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <Text label="Message" value={String(c.message ?? "")} onChange={(v) => set({ message: v })} />
          </>
        )}
        {node.type === "policy.amount_limit" && (
          <>
            <Text label="Amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <Text label="Maximum" value={String((c.max as { value?: string })?.value ?? "")} onChange={(v) => set({ max: { value: v, currency: (c.max as { currency?: string })?.currency ?? "USD" } })} />
              <Text label="Currency" value={String((c.max as { currency?: string })?.currency ?? "USD")} onChange={(v) => set({ max: { value: (c.max as { value?: string })?.value ?? "", currency: v.toUpperCase() } })} />
            </div>
          </>
        )}
        {node.type === "policy.currency" && (
          <>
            <Text label="Amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <Text label="Allowed currencies" value={list(c.allowed)} onChange={(v) => set({ allowed: toList(v.toUpperCase()) })} placeholder="USD" />
          </>
        )}
        {node.type === "policy.amount_limit" && (
          <label className="block">
            <span className="pf-label">Exactly the limit</span>
            <select className={inputCls} value={String(c.comparison ?? "lte")} onChange={(e) => set({ comparison: e.target.value })}>
              <option value="lte">passes (at or below, ≤)</option>
              <option value="lt">is blocked (strictly below, &lt;)</option>
            </select>
          </label>
        )}
        {node.type === "paypal.refund" && (
          <>
            <Text label="Capture id (reference)" mono value={String(c.captureIdRef ?? "")} onChange={(v) => set({ captureIdRef: v })} placeholder="trigger.resourceId" />
            <Text label="Amount to refund (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <Text label="Note to payer" value={String(c.note ?? "")} onChange={(v) => set({ note: v })} />
          </>
        )}
        {node.type === "paypal.payout" && (
          <>
            <Text label="Receiver email (reference)" mono value={String(c.receiverRef ?? "")} onChange={(v) => set({ receiverRef: v })} placeholder="trigger.supplierEmail" />
            <Text label="Amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <Text label="Note" value={String(c.note ?? "")} onChange={(v) => set({ note: v })} />
          </>
        )}
        {node.type === "paypal.order_capture" && (
          <>
            <Text label="Order id (reference)" mono value={String(c.orderIdRef ?? "")} onChange={(v) => set({ orderIdRef: v })} placeholder="trigger.resourceId" />
            <Text label="Expected amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
          </>
        )}
        {node.type === "paypal.invoice_send" && (
          <>
            <Text label="Recipient email (reference)" mono value={String(c.recipientRef ?? "")} onChange={(v) => set({ recipientRef: v })} placeholder="trigger.clientEmail" />
            <Text label="Amount (reference)" mono value={String(c.amountRef ?? "")} onChange={(v) => set({ amountRef: v })} placeholder="trigger.amount" />
            <Text label="Line item description" value={String(c.description ?? "")} onChange={(v) => set({ description: v })} />
            <Text label="Due date (reference, optional)" mono value={String(c.dueDateRef ?? "")} onChange={(v) => set({ dueDateRef: v })} placeholder="trigger.dueDate" />
          </>
        )}
        {node.type === "paypal.invoice_remind" && (
          <>
            <Text label="Invoice id (reference)" mono value={String(c.invoiceIdRef ?? "")} onChange={(v) => set({ invoiceIdRef: v })} placeholder="trigger.invoiceId" />
            <Text label="Subject" value={String(c.subject ?? "")} onChange={(v) => set({ subject: v })} />
          </>
        )}
        {node.type === "paypal.transaction_search" && (
          <Text label="Look back (days)" value={c.days === undefined ? "" : String(c.days)} onChange={(v) => set({ days: num(v) })} />
        )}
        {node.type === "policy.counterparty" && (
          <>
            <Text label="Counterparty (reference)" mono value={String(c.ref ?? "")} onChange={(v) => set({ ref: v })} placeholder="trigger.payer.email" />
            <Text label="Allowed (comma separated)" value={list(c.allowed)} onChange={(v) => set({ allowed: toList(v) })} />
          </>
        )}
      </fieldset>

      <details className="group">
        <summary className="cursor-pointer text-meta text-muted hover:text-ink">Config as JSON</summary>
        <textarea
          className={`${inputCls} mt-2 h-48 font-mono text-meta`}
          disabled={readOnly}
          value={json ?? JSON.stringify(node.config, null, 2)}
          onChange={(e) => {
            setJson(e.target.value);
            setJsonError(null);
          }}
          onBlur={() => {
            if (json === null) return;
            try {
              const parsed = JSON.parse(json);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
              onChange({ ...node, config: parsed });
              setJson(null);
            } catch (e) {
              setJsonError((e as Error).message);
            }
          }}
        />
        {jsonError && <p className="mt-1 text-meta text-danger">Not applied: {jsonError}</p>}
      </details>

      {!readOnly && (
        <button onClick={onDelete} className="inline-flex items-center gap-1.5 text-body-sm text-danger hover:underline">
          <Trash2 size={13} aria-hidden /> Remove node
        </button>
      )}
    </div>
  );
}

const OPS = [
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["eq", "="],
  ["neq", "≠"],
] as const;

/** Simple comparison builder; anything richer is edited as JSON. */
function ConditionEditor({ expr, onChange }: { expr?: Expr; onChange: (e: Expr) => void }) {
  const simple = !expr || ("left" in expr && "right" in expr && OPS.some(([o]) => o === expr.op));
  if (!simple) {
    return (
      <div>
        <span className="pf-label">Condition</span>
        <p className="mt-1 font-mono text-meta text-ink-2">{describeExpr(expr!)}</p>
        <p className="mt-1 text-meta text-muted">Compound condition — edit it in the JSON below.</p>
      </div>
    );
  }
  const e = (expr ?? { op: "gt", left: { ref: "trigger.amount" }, right: { const: "0" } }) as Extract<Expr, { left: unknown; right: unknown }>;
  const leftRef = "ref" in e.left ? e.left.ref : "";
  const right = "const" in e.right ? String(e.right.const ?? "") : "ref" in e.right ? e.right.ref : "";
  const rightIsRef = "ref" in e.right;
  return (
    <div className="space-y-2">
      <span className="pf-label">Condition</span>
      <input className={`${inputCls} font-mono`} value={leftRef} onChange={(ev) => onChange({ ...e, left: { ref: ev.target.value } } as Expr)} placeholder="trigger.amount" />
      <div className="grid grid-cols-[72px_1fr] gap-2">
        <select className={inputCls} value={e.op} onChange={(ev) => onChange({ ...e, op: ev.target.value } as Expr)}>
          {OPS.map(([o, s]) => (
            <option key={o} value={o}>
              {s}
            </option>
          ))}
        </select>
        <input
          className={`${inputCls} ${rightIsRef ? "font-mono" : ""}`}
          value={right}
          onChange={(ev) => {
            const v = ev.target.value;
            onChange({ ...e, right: /^(trigger|nodes|workflow)\./.test(v) ? { ref: v } : { const: v } } as Expr);
          }}
          placeholder="400.00 or a reference"
        />
      </div>
    </div>
  );
}
