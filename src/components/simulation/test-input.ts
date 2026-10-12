import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";

/**
 * The Test Run form, without React: which fields a workflow reads from its
 * trigger, what the browser sends, and how long it waits. Kept pure so the
 * behaviour a person relies on ("what I typed is what was tested") is tested.
 */
export type Field = { key: string; kind: "money" | "text" | "long" };
export type MoneyInput = { value: string; currency: string };

const LONG = /invoice|contract|description|note|purpose|bill|memo|details/i;

/** Fields the graph reads from `trigger.*`, typed by how they are used. */
export function fieldsFor(graph: WorkflowGraph): Field[] {
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

const LABELS: Record<string, string> = {
  counterparty: "Recipient's PayPal email",
  supplierEmail: "Supplier's PayPal email",
  supplier: "Supplier",
  amount: "Amount",
  invoice: "Invoice (as text)",
  contract: "Contract (as text)",
  purpose: "What it is for",
  captureId: "PayPal capture id",
  reference: "Reference",
};

/** A person-readable label for a trigger field: known names, else "dueDate" → "Due date". */
export function fieldLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const words = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The manual-trigger payload exactly as entered: empty fields are absent, never guessed. */
export function manualPayload(fields: Field[], values: Record<string, string>, money: Record<string, MoneyInput>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === "money") {
      const m = money[f.key];
      if (m?.value.trim()) p[f.key] = { value: m.value.trim(), currency_code: (m.currency || "USD").trim().toUpperCase() };
    } else if (values[f.key]?.trim()) p[f.key] = values[f.key].trim();
  }
  return p;
}

/** Fields the workflow reads that the person left empty — the engine will treat them as missing. */
export function emptyFields(fields: Field[], values: Record<string, string>, money: Record<string, MoneyInput>): string[] {
  return fields.filter((f) => (f.kind === "money" ? !money[f.key]?.value.trim() : !values[f.key]?.trim())).map((f) => f.key);
}

/** How long the dialog waits for PayFlow before saying so (a Test Run normally answers in well under a second; AI steps take seconds). */
export const TEST_RUN_WAIT_MS = 90_000;
/** How long an in-app navigation to the result may take before the browser loads it directly. */
export const RESULT_NAVIGATION_FALLBACK_MS = 8_000;

/** Resolves with the promise's result, or with "timeout" once `ms` passes — whichever is first. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
