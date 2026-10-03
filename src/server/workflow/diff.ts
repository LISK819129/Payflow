import { canonicalJson } from "../audit/canonical";
import { SPEC_BY_TYPE, type WorkflowGraph } from "./dsl/nodes";

export type GraphChange =
  | { kind: "node_added"; nodeId: string; title: string }
  | { kind: "node_removed"; nodeId: string; title: string }
  | { kind: "config_changed"; nodeId: string; title: string; path: string; before: unknown; after: unknown }
  | { kind: "edges_changed"; added: string[]; removed: string[] };

/** Field-level diff between two graphs, used for review ("$500 → $350") and the audit record. */
export function diffGraphs(before: WorkflowGraph | null, after: WorkflowGraph): GraphChange[] {
  const changes: GraphChange[] = [];
  const prev = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const title = (n: { type: string; label?: string }) => n.label ?? SPEC_BY_TYPE[n.type]?.title ?? n.type;

  for (const [id, n] of next) {
    const p = prev.get(id);
    if (!p) {
      changes.push({ kind: "node_added", nodeId: id, title: title(n) });
      continue;
    }
    for (const c of diffValues(p.config, n.config, "")) changes.push({ kind: "config_changed", nodeId: id, title: title(n), ...c });
    if (p.type !== n.type) changes.push({ kind: "config_changed", nodeId: id, title: title(n), path: "type", before: p.type, after: n.type });
  }
  for (const [id, p] of prev) if (!next.has(id)) changes.push({ kind: "node_removed", nodeId: id, title: title(p) });

  const key = (e: { from: string; to: string; port: string }) => `${e.from}:${e.port}→${e.to}`;
  const pe = new Set((before?.edges ?? []).map(key));
  const ne = new Set(after.edges.map(key));
  const added = [...ne].filter((k) => !pe.has(k));
  const removed = [...pe].filter((k) => !ne.has(k));
  if (added.length || removed.length) changes.push({ kind: "edges_changed", added, removed });
  return changes;
}

function diffValues(a: unknown, b: unknown, path: string): { path: string; before: unknown; after: unknown }[] {
  if (canonicalJson(a) === canonicalJson(b)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) =>
      diffValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return [{ path: path || "(value)", before: a, after: b }];
}

/** Human summary of one change, e.g. `Amount limit: max.value 500.00 → 350.00`. */
export function describeChange(c: GraphChange): string {
  switch (c.kind) {
    case "node_added":
      return `Added ${c.title}`;
    case "node_removed":
      return `Removed ${c.title}`;
    case "config_changed":
      return `${c.title}: ${c.path} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`;
    case "edges_changed":
      return `Connections changed (+${c.added.length} / −${c.removed.length})`;
  }
}
