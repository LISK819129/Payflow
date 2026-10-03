"use client";

import { CircleAlert, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyProposalAction, discardProposalAction, proposePatchAction, type PatchActionResult } from "@/app/(app)/flows/ai-actions";
import { Button, ProvenanceTag } from "@/components/ui";
import type { GraphChange } from "@/server/workflow/diff";
import { CompileStages, type Stage } from "./compile-stages";
import { RevealGraph } from "./reveal-graph";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function ChangeLine({ c }: { c: GraphChange }) {
  switch (c.kind) {
    case "config_changed":
      return (
        <span>
          <span className="text-ink-2">{c.title}</span> <span className="font-mono text-meta text-muted">{c.path}</span>{" "}
          <span className="font-mono">{fmt(c.before)}</span> <span aria-hidden>→</span> <span className="pf-mark font-mono font-medium text-ink">{fmt(c.after)}</span>
        </span>
      );
    case "node_added":
      return (
        <span>
          Adds <span className="font-medium text-ink">{c.title}</span>
        </span>
      );
    case "node_removed":
      return (
        <span>
          Removes <span className="font-medium text-ink">{c.title}</span>
        </span>
      );
    case "edges_changed":
      return (
        <span className="text-muted">
          Connections: +{c.added.length} / −{c.removed.length}
        </span>
      );
  }
}

/** The Flow Builder's command bar: describe a change, review the exact diff, keep or discard. */
export function PatchBar({ workflowId, aiConfigured, disabledReason }: { workflowId: string; aiConfigured: boolean; disabledReason?: string }) {
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<PatchActionResult | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const disabled = !aiConfigured || !!disabledReason;

  const submit = () =>
    start(async () => {
      setResult(null);
      setError(null);
      setAck(false);
      setStage("Understand");
      await sleep(150);
      setStage("Compile");
      const r = await proposePatchAction(workflowId, instruction);
      setStage("Validate");
      await sleep(300);
      setResult(r);
      setStage(r.status === "PROPOSED" || r.status === "NEEDS_CLARIFICATION" || r.status === "UNSUPPORTED" ? "Ready" : "Validate");
    });

  const close = () => {
    if (result?.status === "PROPOSED") void discardProposalAction(result.compilationId);
    setResult(null);
    setStage("idle");
  };

  const highlight: Record<string, "added" | "changed"> = {};
  if (result?.status === "PROPOSED") {
    for (const c of result.changes) {
      if (c.kind === "node_added") highlight[c.nodeId] = "added";
      else if (c.kind === "config_changed") highlight[c.nodeId] = "changed";
    }
  }

  return (
    <div className="border-b border-line bg-surface">
      <form
        className="flex items-center gap-3 px-5 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && !pending && instruction.trim()) submit();
        }}
      >
        <Sparkles size={15} className="shrink-0 text-marker-ink" aria-hidden />
        <label htmlFor="pf-command" className="sr-only">
          Describe a change to this workflow
        </label>
        <input
          id="pf-command"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={disabled}
          placeholder={disabledReason ?? (aiConfigured ? "Describe a change — e.g. “Reduce the limit to $350, except AWS which stays at $500”" : "AI provider not configured")}
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-faint focus-visible:shadow-none disabled:cursor-not-allowed"
        />
        {stage !== "idle" && <div className="hidden lg:block"><CompileStages stage={stage} failed={!!result && ["INVALID", "FAILED"].includes(result.status)} /></div>}
        <Button size="sm" type="submit" variant="secondary" disabled={disabled || pending || !instruction.trim()}>
          {pending ? "Working…" : "Propose change"}
        </Button>
      </form>

      {result && (
        <div className="border-t border-line px-5 py-4 animate-fade-up" role="region" aria-label="Proposed change">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="pf-label">{result.status === "PROPOSED" ? "Proposed change" : "AI edit"}</span>
              {"ai" in result && result.ai && <ProvenanceTag value="AI_GENERATED" />}
            </div>
            <button onClick={close} aria-label="Close" className="text-muted hover:text-ink">
              <X size={15} />
            </button>
          </div>

          {"ai" in result && result.ai && <p className="mt-2 max-w-3xl text-body text-ink-2">{result.ai.interpretation}</p>}

          {result.status === "PROPOSED" && (
            <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h4 className="pf-label">Exact changes · PayFlow diff</h4>
                {result.changes.length === 0 ? (
                  <p className="mt-2 text-body-sm text-muted">No change to the workflow.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 text-body-sm">
                    {result.changes.map((c, i) => (
                      <li key={i}>
                        <ChangeLine c={c} />
                      </li>
                    ))}
                  </ul>
                )}
                {result.weakened.length > 0 && (
                  <div className="mt-4 border-l-2 border-warn pl-3">
                    <div className="flex items-center gap-1.5 text-body-sm font-medium text-warn">
                      <CircleAlert size={14} aria-hidden /> This weakens controls
                    </div>
                    <ul className="mt-1 space-y-0.5 text-body-sm text-ink-2">
                      {result.weakened.map((w, i) => (
                        <li key={i}>{w.message}</li>
                      ))}
                    </ul>
                    <label className="mt-2 flex items-center gap-2 text-body-sm">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand and want this change
                    </label>
                  </div>
                )}
                <p className="mt-4 text-meta text-muted">Keeping saves a new draft version. The active version keeps running until you activate the draft.</p>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={pending || result.changes.length === 0 || (result.weakened.length > 0 && !ack)}
                    onClick={() =>
                      start(async () => {
                        const r = await applyProposalAction(result.compilationId, ack, workflowId);
                        if (!r.ok) setError(r.error);
                        else {
                          setResult(null);
                          setStage("idle");
                          setInstruction("");
                          router.refresh();
                        }
                      })
                    }
                  >
                    Keep changes
                  </Button>
                  <Button variant="quiet" size="sm" onClick={close}>
                    Discard
                  </Button>
                </div>
                {error && <p className="mt-2 text-body-sm text-danger">{error}</p>}
              </div>
              <div className="h-[340px] rounded border border-line bg-canvas">
                <RevealGraph graph={result.graph} highlight={highlight} stepMs={40} />
              </div>
            </div>
          )}

          {result.status === "NEEDS_CLARIFICATION" && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-body-sm text-ink-2">
              {result.questions.map((q, i) => (
                <li key={i}>{q.question}</li>
              ))}
            </ul>
          )}
          {result.status === "UNSUPPORTED" && (
            <ul className="mt-3 space-y-1 text-body-sm text-danger">
              {result.ai.unsupported.map((u, i) => (
                <li key={i}>
                  {u.request} — {u.reason}
                </li>
              ))}
            </ul>
          )}
          {result.status === "INVALID" && (
            <div className="mt-3 text-body-sm text-danger">
              The proposed edit failed PayFlow&apos;s checks after one repair; nothing changed.
              <ul className="mt-1 list-disc pl-5">
                {result.problems.slice(0, 6).map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {(result.status === "FAILED" || result.status === "SETUP_REQUIRED" || result.status === "FORBIDDEN") && (
            <p className="mt-3 text-body-sm text-danger">{result.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
