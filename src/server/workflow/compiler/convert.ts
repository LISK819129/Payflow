import type { WireNode } from "../../ai/types";
import type { GraphNode, WorkflowGraph } from "../dsl/nodes";

export type ConvertProblem = string;

/** Parses a wire node's JSON-encoded config. Never evaluates anything. */
export function wireToNode(w: WireNode, problems: ConvertProblem[]): GraphNode | null {
  let config: unknown;
  try {
    config = w.config_json.trim() === "" ? {} : JSON.parse(w.config_json);
  } catch {
    problems.push(`Node "${w.id}": config_json is not valid JSON`);
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    problems.push(`Node "${w.id}": config_json must be a JSON object`);
    return null;
  }
  return { id: w.id, type: w.type, label: w.label?.trim() || undefined, config: config as Record<string, unknown> };
}

export function wireToGraph(nodes: WireNode[], edges: { from: string; port: string; to: string }[]): { graph: WorkflowGraph; problems: ConvertProblem[] } {
  const problems: ConvertProblem[] = [];
  const out = nodes.map((n) => wireToNode(n, problems)).filter((n): n is GraphNode => n !== null);
  return { graph: { schemaVersion: 1, nodes: out, edges: edges.map((e) => ({ from: e.from, port: e.port, to: e.to })) }, problems };
}

/** The graph as the model sees it when editing: config inline, no layout. */
export function graphForModel(g: WorkflowGraph) {
  return { nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label ?? "", config: n.config })), edges: g.edges };
}
