import { notFound } from "next/navigation";
import { FlowBuilder } from "@/components/flow/builder";
import { canAuthorize, requireUser } from "@/server/auth/current";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { getWorkflowForEditing } from "@/server/workflow/queries";

export default async function FlowPage(props: PageProps<"/flows/[id]">) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getWorkflowForEditing(user.workspaceId, id);
  if (!data) notFound();
  return (
    <FlowBuilder
      key={data.latest.id + data.latest.updatedAt.toISOString()}
      workflowId={data.wf.id}
      name={data.wf.name}
      state={data.wf.state}
      latestVersion={data.latest.version}
      latestStatus={data.latest.status}
      activeVersion={data.active?.version ?? null}
      initialGraph={data.latest.graph as WorkflowGraph}
      canAuthorize={canAuthorize(user)}
    />
  );
}
