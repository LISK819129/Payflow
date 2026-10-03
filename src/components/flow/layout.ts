import dagre from "@dagrejs/dagre";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";

export const NODE_W = 248;
export const NODE_H = 78;

/** Top-to-bottom layered layout; stored positions win, missing ones are computed. */
export function layoutGraph(graph: WorkflowGraph, force = false): Record<string, { x: number; y: number }> {
  const have = graph.layout ?? {};
  if (!force && graph.nodes.every((n) => have[n.id])) return have;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of graph.nodes) {
    const p = g.node(n.id);
    out[n.id] = force || !have[n.id] ? { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) } : have[n.id];
  }
  return out;
}
