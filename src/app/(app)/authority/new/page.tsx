import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db/client";
import { workflows } from "@/server/db/schema";
import { AuthorityForm } from "../authority-form";

export default async function NewAuthorityPage() {
  const user = await requireUser();
  if (user.role !== "OWNER") redirect("/authority");
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, user.workspaceId)).orderBy(workflows.name);
  return (
    <>
      <PageHeader title="New authority" lead="Delegate a bounded slice of financial authority to one or more workflows." />
      <AuthorityForm
        workflows={wfs}
        initial={{
          name: "",
          description: "",
          workflowIds: [],
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
          purposeScope: "",
          policy: {},
        }}
      />
    </>
  );
}
