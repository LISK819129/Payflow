"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ArrowLeftRight,
  BookCheck,
  CircleCheck,
  CircleX,
  Clock,
  Flag,
  GitBranch,
  Hand,
  Hourglass,
  Radio,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Stamp,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";
import { SPEC_BY_TYPE, type GraphNode } from "@/server/workflow/dsl/nodes";
import { RUNTIME_PHASE } from "@/server/workflow/dsl/validate";
import { NODE_W } from "./layout";
import { summarizeNode } from "./describe";

const ICONS: Record<string, LucideIcon> = {
  "trigger.paypal_event": Radio,
  "trigger.manual": Hand,
  "trigger.schedule": Clock,
  "trigger.agent_request": Radio,
  "control.condition": GitBranch,
  "control.approval": Stamp,
  "control.delay": Hourglass,
  "control.freeze": Snowflake,
  "control.terminal": Flag,
  "paypal.refund": Undo2,
  "ledger.reconcile": BookCheck,
};

function iconFor(type: string): LucideIcon {
  const cat = SPEC_BY_TYPE[type]?.category;
  return ICONS[type] ?? (cat === "policy" ? ShieldCheck : cat === "ai" ? Sparkles : cat === "paypal" ? ArrowLeftRight : Flag);
}

/** Execution state of a node in a run view. */
export type NodeRunState = "idle" | "ok" | "error" | "waiting" | "current";

export type FlowNodeData = {
  node: GraphNode;
  issues?: number;
  runState?: NodeRunState;
  /** Port taken when this node ran (run view). */
  takenPort?: string | null;
  /** Proposed-edit view: this node is new or changed. */
  highlight?: "added" | "changed";
};

export type FlowNode = Node<FlowNodeData, "pf">;

const PORT_LABEL: Record<string, string> = { next: "", true: "yes", false: "no", pass: "pass", block: "block", approved: "approved", rejected: "rejected", elapsed: "", done: "done", error: "error" };

export function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { node, issues, runState = "idle", takenPort, highlight } = data;
  const spec = SPEC_BY_TYPE[node.type];
  const ports = spec?.ports ?? [];
  const isAI = spec?.isAI;
  const unavailable = spec && spec.implementedIn > RUNTIME_PHASE;

  const border =
    runState === "ok" || runState === "current"
      ? "border-marker"
      : runState === "error"
        ? "border-danger"
        : runState === "waiting"
          ? "border-warn"
          : highlight
            ? "border-marker border-[1.5px]"
            : selected
              ? "border-ink"
              : "border-line-strong";

  return (
    <div
      style={{ width: NODE_W }}
      className={`group relative rounded border bg-surface px-3 py-2.5 transition-[border-color,box-shadow] duration-[var(--pf-dur)] ${border} ${
        selected ? "shadow-[0_0_0_4px_var(--pf-marker-wash)]" : ""
      } ${runState === "ok" || runState === "current" ? "border-[1.5px]" : ""} ${runState === "idle" && data.runState ? "opacity-55" : ""}`}
    >
      {spec?.category !== "trigger" && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-ink !bg-surface" />}
      <div className="flex items-center gap-1.5">
        {createElement(iconFor(node.type), { size: 13, strokeWidth: 1.75, className: isAI ? "text-marker-ink" : "text-ink-2", "aria-hidden": true })}
        <span className="pf-label truncate text-ink">{spec?.title ?? node.type}</span>
        {runState === "ok" && <CircleCheck size={13} className="ml-auto text-ok" aria-label="ran" />}
        {runState === "error" && <CircleX size={13} className="ml-auto text-danger" aria-label="error" />}
        {runState === "waiting" && <Hourglass size={13} className="ml-auto text-warn" aria-label="waiting" />}
        {highlight && (
          <span className="ml-auto rounded-sm bg-marker px-1 font-mono text-[10px] font-medium text-on-marker">{highlight === "added" ? "new" : "changed"}</span>
        )}
        {!data.runState && !highlight && !!issues && (
          <span className="ml-auto rounded-sm bg-danger-wash px-1 font-mono text-[10px] text-danger" title={`${issues} problem(s)`}>
            {issues}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-body-sm font-medium text-ink">{node.label ?? spec?.title}</div>
      <div className="truncate text-meta text-muted" title={summarizeNode(node)}>
        {summarizeNode(node)}
      </div>
      {unavailable && <div className="mt-1 font-mono text-[10px] text-faint">runs from Phase {spec.implementedIn}</div>}

      {ports.map((p, i) => {
        const left = `${((i + 1) / (ports.length + 1)) * 100}%`;
        const taken = takenPort === p;
        return (
          <div key={p}>
            <Handle
              id={p}
              type="source"
              position={Position.Bottom}
              style={{ left }}
              className={`!h-2 !w-2 ${p === "error" ? "!border-danger" : "!border-ink"} ${taken ? "!bg-marker" : "!bg-surface"}`}
            />
            {PORT_LABEL[p] !== "" && ports.length > 1 && (
              <span
                className={`pointer-events-none absolute -bottom-4 -translate-x-1/2 font-mono text-[10px] ${taken ? "text-ink" : "text-faint"}`}
                style={{ left }}
              >
                {PORT_LABEL[p] ?? p}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
