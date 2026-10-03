import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { Button, Empty, PageHeader, Status, formatClock, formatDay, type StatusTone } from "@/components/ui";
import { CompilePanel } from "@/components/flow/compile-panel";
import { canAuthorize, requireUser } from "@/server/auth/current";
import { integrationStatus } from "@/server/config/env";
import { storedCompileOutcome } from "@/server/workflow/compiler/compile";
import { listWorkflows } from "@/server/workflow/queries";
import { createWorkflowAction } from "./actions";

const stateTone: Record<string, StatusTone> = {
  ACTIVE: "live",
  DRAFT: "neutral",
  PAUSED: "warn",
  FROZEN: "danger",
  FAILED: "danger",
  EXPIRED: "neutral",
  COMPLETED: "ok",
};

export default async function FlowsPage(props: PageProps<"/flows">) {
  const user = await requireUser();
  const q = await props.searchParams;
  const stored = typeof q.compilation === "string" && /^[0-9a-f-]{36}$/.test(q.compilation) ? await storedCompileOutcome(user.workspaceId, q.compilation) : null;
  const flows = await listWorkflows(user.workspaceId);
  return (
    <>
      <PageHeader
        title="Flows"
        lead="Each flow is a versioned graph. Edits never change a version that is running; activation is always a person's decision."
        actions={
          <form action={createWorkflowAction} className="flex items-end gap-2">
            <label className="block">
              <span className="sr-only">Name</span>
              <input
                name="name"
                placeholder="New flow name"
                className="h-9 w-56 border-0 border-b border-field bg-transparent px-0 text-body outline-none focus:border-ink focus-visible:shadow-none"
              />
            </label>
            <Button type="submit" variant="primary">
              <Plus size={15} aria-hidden /> New flow
            </Button>
          </form>
        }
      />
      {canAuthorize(user) && (
        <CompilePanel
          aiConfigured={integrationStatus().ai.configured}
          stored={stored ? { instruction: stored.instruction, result: stored.outcome, model: stored.model, at: stored.createdAt.toISOString() } : undefined}
        />
      )}
      {flows.length === 0 ? (
        <Empty>No flows yet. Describe one above, or create an empty flow and build it by hand.</Empty>
      ) : (
        <ul>
          {flows.map((f) => (
            <li key={f.id} className="border-b border-line last:border-b-0">
              <Link href={`/flows/${f.id}`} className="group flex items-center gap-6 py-4 hover:bg-sunken/50">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lead font-medium">{f.name}</div>
                  <div className="mt-0.5 text-body-sm text-muted">
                    v{f.latestVersion}
                    {f.activeVersionId ? "" : " · never activated"}
                    {f.frozenReason ? ` · ${f.frozenReason}` : ""}
                  </div>
                </div>
                <div className="hidden w-40 text-body-sm text-muted sm:block">
                  {f.runs} run{f.runs === 1 ? "" : "s"}
                  {f.lastRun && (
                    <div className="font-mono text-meta text-faint">
                      last {formatDay(f.lastRun)} {formatClock(f.lastRun)}
                    </div>
                  )}
                </div>
                <div className="w-28">
                  <Status tone={stateTone[f.state] ?? "neutral"}>{f.state.toLowerCase()}</Status>
                </div>
                <ArrowRight size={15} className="text-faint transition-transform duration-[var(--pf-dur-fast)] group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
