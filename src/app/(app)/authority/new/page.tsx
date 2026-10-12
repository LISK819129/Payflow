import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { workflows } from "@/server/db/schema";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { getWorkflowForEditing } from "@/server/workflow/queries";
import { summarizeRule } from "@/server/workflow/rule-summary";
import { AuthorityForm } from "../authority-form";

export default async function NewAuthorityPage(props: PageProps<"/authority/new">) {
  const user = await requireUser();
  const { workflow } = await props.searchParams;
  if (user.role !== "OWNER") redirect("/authority");
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, user.workspaceId)).orderBy(workflows.name);
  // ?workflow=<id> (from a Test Run that found no authority) pre-selects that workflow — only one of this workspace's.
  const preselected = typeof workflow === "string" && wfs.some((w) => w.id === workflow) ? [workflow] : [];
  // If that workflow checks purpose against its own wording, start the authority from the same words:
  // an authority only accepts a purpose check made against its exact wording.
  let purposeScope = "";
  if (preselected.length) {
    const data = await getWorkflowForEditing(user.workspaceId, preselected[0]);
    purposeScope = data ? (summarizeRule(data.latest.graph as WorkflowGraph).purposeScopes[0] ?? "") : "";
  }
  return (
    <>
      <PageHeader title="New authority" lead="Delegate a bounded slice of financial authority to one or more workflows." />
      <AuthorityForm
        workflows={wfs}
        initial={{
          name: "",
          description: "",
          workflowIds: preselected,
          actions: [],
          counterpartyRule: "allowlist",
          counterparties: "",
          denied: "",
          currencies: "USD",
          perTransactionMax: "",
          budgetAmount: "",
          budgetPeriod: "",
          maxCount: "",
          countPeriod: "",
          validFrom: "",
          expiresAt: "",
          purposeScope,
          policy: {},
        }}
      />
    </>
  );
}
