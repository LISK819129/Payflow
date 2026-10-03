"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { GraphCanvas } from "./graph-canvas";
import { layoutGraph } from "./layout";

/** Nodes in the order a run would meet them (breadth-first from the trigger). */
function revealOrder(g: WorkflowGraph): string[] {
  const incoming = new Set(g.edges.map((e) => e.to));
  const start = g.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of g.edges) if (e.from === id) queue.push(e.to);
  }
  for (const n of g.nodes) if (!seen.has(n.id)) order.push(n.id);
  return order;
}

function Reveal({ graph, highlight, stepMs }: { graph: WorkflowGraph; highlight?: Record<string, "added" | "changed">; stepMs: number }) {
  const positions = useMemo(() => layoutGraph(graph, true), [graph]);
  const order = useMemo(() => revealOrder(graph), [graph]);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [count, setCount] = useState(reduced ? order.length : 1);

  useEffect(() => {
    if (count >= order.length) return;
    const t = setTimeout(() => setCount((c) => c + 1), stepMs);
    return () => clearTimeout(t);
  }, [count, order.length, stepMs]);

  const visible = useMemo(() => new Set(order.slice(0, count)), [order, count]);
  return <GraphCanvas graph={graph} positions={positions} visible={visible} highlight={highlight} />;
}

/** A compiled graph drawn node by node, so the shape of the flow is readable as it appears. */
export function RevealGraph({ graph, highlight, stepMs = 110 }: { graph: WorkflowGraph; highlight?: Record<string, "added" | "changed">; stepMs?: number }) {
  return (
    <ReactFlowProvider>
      <Reveal graph={graph} highlight={highlight} stepMs={stepMs} />
    </ReactFlowProvider>
  );
}
