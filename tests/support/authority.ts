import { createAuthority, type AuthorityInput } from "@/server/authority/service";

/** Grants a workflow delegated authority through the same service the app uses. */
export async function grantAuthority(workspaceId: string, userId: string, workflowIds: string[], overrides: Partial<AuthorityInput> = {}) {
  const r = await createAuthority({
    workspaceId,
    userId,
    data: {
      name: "Test authority",
      workflowIds,
      actions: ["paypal.payout", "paypal.refund", "paypal.order_capture", "paypal.invoice_send", "paypal.invoice_remind"],
      counterpartyRule: "any",
      currencies: ["USD"],
      ...overrides,
    },
  });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}
