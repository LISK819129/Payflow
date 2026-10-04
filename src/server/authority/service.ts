import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit/audit";
import { db } from "../db/client";
import { authorities, workflows } from "../db/schema";

/**
 * Creating, editing, suspending and revoking delegated authority. Every change
 * is a deliberate, audited act by a person: a new version number and a record
 * of exactly what changed. There is no implicit "always allow".
 */

export const PROTECTED_ACTIONS = ["paypal.payout", "paypal.refund", "paypal.order_capture", "paypal.invoice_send", "paypal.invoice_remind"] as const;

const MONEY = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "amount like 500 or 500.00");
const party = z.object({ id: z.string().trim().min(3).max(200), name: z.string().trim().max(80).optional() });

export const AuthorityInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional(),
    workflowIds: z.array(z.string().uuid()).min(1, "choose at least one workflow").max(50),
    actions: z.array(z.enum(PROTECTED_ACTIONS)).min(1, "choose at least one action"),
    counterpartyRule: z.enum(["allowlist", "any"]),
    counterparties: z.array(party).max(200).default([]),
    deniedCounterparties: z.array(party).max(200).default([]),
    currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(5),
    perTransactionMax: MONEY.nullable().default(null),
    budgetAmount: MONEY.nullable().default(null),
    budgetPeriod: z.enum(["day", "week", "month"]).nullable().default(null),
    maxCount: z.number().int().min(1).max(100000).nullable().default(null),
    countPeriod: z.enum(["hour", "day", "week", "month"]).nullable().default(null),
    validFrom: z.coerce.date().nullable().default(null),
    expiresAt: z.coerce.date().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.counterpartyRule === "allowlist" && v.counterparties.length === 0) ctx.addIssue({ code: "custom", path: ["counterparties"], message: "an allowlist needs at least one counterparty" });
    if (!!v.budgetAmount !== !!v.budgetPeriod) ctx.addIssue({ code: "custom", path: ["budgetPeriod"], message: "a budget needs both an amount and a period" });
    if (!!v.maxCount !== !!v.countPeriod) ctx.addIssue({ code: "custom", path: ["countPeriod"], message: "a frequency limit needs both a count and a period" });
    if (v.validFrom && v.expiresAt && v.expiresAt <= v.validFrom) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiry must be after the start" });
  });
export type AuthorityInput = z.input<typeof AuthorityInput>;

/** "500" → "500.00": stored and compared exactly as Postgres numeric(16,2) returns it. */
const money2 = (v: string | null) => {
  if (v === null) return null;
  const [i, f = ""] = v.split(".");
  return `${i}.${(f + "00").slice(0, 2)}`;
};

type Result = { ok: true; id: string; version: number } | { ok: false; error: string };

async function checkWorkflows(workspaceId: string, ids: string[]) {
  const rows = await db().select({ id: workflows.id }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), inArray(workflows.id, ids)));
  return rows.length === new Set(ids).size;
}

const fieldsOf = (v: z.output<typeof AuthorityInput>) => ({
  name: v.name,
  description: v.description ?? null,
  workflowIds: v.workflowIds,
  actions: [...v.actions],
  counterpartyRule: v.counterpartyRule,
  counterparties: v.counterparties.map((c) => ({ id: c.id.toLowerCase(), ...(c.name ? { name: c.name } : {}) })),
  deniedCounterparties: v.deniedCounterparties.map((c) => ({ id: c.id.toLowerCase(), ...(c.name ? { name: c.name } : {}) })),
  currencies: v.currencies,
  perTransactionMax: money2(v.perTransactionMax),
  budgetAmount: money2(v.budgetAmount),
  budgetPeriod: v.budgetPeriod,
  maxCount: v.maxCount,
  countPeriod: v.countPeriod,
  validFrom: v.validFrom,
  expiresAt: v.expiresAt,
});

export async function createAuthority(input: { workspaceId: string; userId: string; data: unknown }): Promise<Result> {
  const parsed = AuthorityInput.safeParse(input.data);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "authority"}: ${i.message}`).join("; ") };
  if (!(await checkWorkflows(input.workspaceId, parsed.data.workflowIds))) return { ok: false, error: "Unknown workflow" };
  return db().transaction(async (tx) => {
    const [a] = await tx
      .insert(authorities)
      .values({ workspaceId: input.workspaceId, createdBy: input.userId, ...fieldsOf(parsed.data) })
      .returning();
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "authority.created",
      summary: `Authority “${a.name}” v1 created`,
      payload: { authorityId: a.id, authority: fieldsOf(parsed.data) },
    });
    return { ok: true as const, id: a.id, version: a.version };
  });
}

export async function updateAuthority(input: { workspaceId: string; userId: string; authorityId: string; data: unknown }): Promise<Result> {
  const parsed = AuthorityInput.safeParse(input.data);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "authority"}: ${i.message}`).join("; ") };
  if (!(await checkWorkflows(input.workspaceId, parsed.data.workflowIds))) return { ok: false, error: "Unknown workflow" };
  return db().transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(authorities)
      .where(and(eq(authorities.id, input.authorityId), eq(authorities.workspaceId, input.workspaceId)))
      .for("update");
    if (!cur) return { ok: false as const, error: "Authority not found" };
    if (cur.status === "REVOKED") return { ok: false as const, error: "A revoked authority cannot be edited" };
    const next = fieldsOf(parsed.data);
    const changes = Object.entries(next)
      .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((cur as Record<string, unknown>)[k] ?? null))
      .map(([k, v]) => ({ field: k, from: (cur as Record<string, unknown>)[k] ?? null, to: v }));
    if (changes.length === 0) return { ok: true as const, id: cur.id, version: cur.version };
    const [a] = await tx
      .update(authorities)
      .set({ ...next, version: cur.version + 1, updatedAt: new Date() })
      .where(eq(authorities.id, cur.id))
      .returning();
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: "authority.changed",
      summary: `Authority “${a.name}” v${cur.version} → v${a.version}: ${changes.map((c) => c.field).join(", ")} changed`,
      payload: { authorityId: a.id, changes },
    });
    return { ok: true as const, id: a.id, version: a.version };
  });
}

export async function setAuthorityStatus(input: { workspaceId: string; userId: string; authorityId: string; to: "ACTIVE" | "SUSPENDED" | "REVOKED"; reason?: string }): Promise<Result> {
  return db().transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(authorities)
      .where(and(eq(authorities.id, input.authorityId), eq(authorities.workspaceId, input.workspaceId)))
      .for("update");
    if (!cur) return { ok: false as const, error: "Authority not found" };
    if (cur.status === "REVOKED") return { ok: false as const, error: "Already revoked" };
    if (cur.status === input.to) return { ok: true as const, id: cur.id, version: cur.version };
    const [a] = await tx
      .update(authorities)
      .set({ status: input.to, statusReason: input.to === "ACTIVE" ? null : (input.reason?.slice(0, 200) ?? null), version: cur.version + 1, updatedAt: new Date() })
      .where(eq(authorities.id, cur.id))
      .returning();
    const verb = input.to === "ACTIVE" ? "resumed" : input.to === "SUSPENDED" ? "suspended" : "revoked";
    await appendAudit(tx, {
      workspaceId: input.workspaceId,
      actor: `user:${input.userId}`,
      kind: `authority.${verb}`,
      summary: `Authority “${a.name}” ${verb}${input.reason ? `: ${input.reason}` : ""} (v${a.version})`,
      payload: { authorityId: a.id, from: cur.status, to: input.to, reason: input.reason ?? null },
    });
    return { ok: true as const, id: a.id, version: a.version };
  });
}
