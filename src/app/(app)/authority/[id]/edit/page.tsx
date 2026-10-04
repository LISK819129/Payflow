import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { getAuthority } from "@/server/authority/queries";
import { db } from "@/server/db/client";
import { workflows } from "@/server/db/schema";
import { AuthorityForm } from "../../authority-form";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const lines = (list: { id: string; name?: string }[]) => list.map((c) => (c.name ? `${c.id}, ${c.name}` : c.id)).join("\n");

export default async function EditAuthorityPage(props: PageProps<"/authority/[id]/edit">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (user.role !== "OWNER") redirect("/authority");
  const a = await getAuthority(user.workspaceId, id);
  if (!a) notFound();
  const wfs = await db().select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.workspaceId, user.workspaceId)).orderBy(workflows.name);
  return (
    <>
      <PageHeader title={`Edit “${a.name}”`} lead={`Version ${a.version}. Saving creates version ${a.version + 1}; the next request is decided under it.`} />
      <AuthorityForm
        id={a.id}
        workflows={wfs}
        initial={{
          name: a.name,
          description: a.description ?? "",
          workflowIds: a.workflowIds,
          actions: a.actions,
          counterpartyRule: a.counterpartyRule,
          counterparties: lines(a.counterparties),
          denied: lines(a.deniedCounterparties),
          currencies: a.currencies.join(", "),
          perTransactionMax: a.perTransactionMax ?? "",
          budgetAmount: a.budgetAmount ?? "",
          budgetPeriod: a.budgetPeriod ?? "",
          maxCount: a.maxCount ? String(a.maxCount) : "",
          countPeriod: a.countPeriod ?? "",
          validFrom: day(a.validFrom),
          expiresAt: day(a.expiresAt),
          purposeScope: a.purposeScope ?? "",
          policy: a.intelligencePolicy ?? {},
        }}
      />
    </>
  );
}
