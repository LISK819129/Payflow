import type { z } from "zod";
import { exprRefs, type Expr } from "./expression";
import { Graph, SPEC_BY_TYPE, type Edge, type GraphNode, type NodeSpec, type WorkflowGraph } from "./nodes";

/** The highest phase whose node executors exist. Bumped as phases land. */
export const RUNTIME_PHASE = 3;

export type Issue = { severity: "error" | "warning"; code: string; message: string; nodeId?: string };

export type ValidationResult =
  | { ok: true; graph: WorkflowGraph; issues: Issue[] }
  | { ok: false; graph?: WorkflowGraph; issues: Issue[] };

/** Ports on a gate node that mean "the rule was satisfied". */
const GATE_PASS_PORTS: Record<string, string> = { pass: "pass", approved: "approved" };

/**
 * Structural and safety validation of a workflow graph.
 * `forActivation` additionally requires every node's executor to exist.
 */
export function validateGraph(input: unknown, opts: { forActivation?: boolean } = {}): ValidationResult {
  const issues: Issue[] = [];
  const err = (code: string, message: string, nodeId?: string) => issues.push({ severity: "error", code, message, nodeId });
  const warn = (code: string, message: string, nodeId?: string) => issues.push({ severity: "warning", code, message, nodeId });

  const shape = Graph.safeParse(input);
  if (!shape.success) {
    for (const i of shape.error.issues) err("schema", `${i.path.join(".") || "graph"}: ${i.message}`);
    return { ok: false, issues };
  }

  // Per-type config validation.
  const nodes: GraphNode[] = [];
  for (const n of shape.data.nodes) {
    const spec = SPEC_BY_TYPE[n.type];
    const cfg = (spec.config as z.ZodTypeAny).safeParse(n.config ?? {});
    if (!cfg.success) {
      for (const i of cfg.error.issues) err("config", `${spec.title}: ${i.path.join(".") || "config"} — ${i.message}`, n.id);
      nodes.push({ ...n, config: (n.config ?? {}) as Record<string, unknown> });
    } else {
      nodes.push({ ...n, config: cfg.data as Record<string, unknown> });
    }
  }
  const graph: WorkflowGraph = { schemaVersion: 1, nodes, edges: shape.data.edges, layout: shape.data.layout };

  const byId = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) err("duplicate_id", `Two nodes share the id "${n.id}"`, n.id);
    byId.set(n.id, n);
  }
  const spec = (id: string): NodeSpec => SPEC_BY_TYPE[byId.get(id)!.type];

  // Edges.
  const out = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const seenPort = new Set<string>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      err("dangling_edge", `Edge ${e.from} → ${e.to} references a missing node`);
      continue;
    }
    if (e.from === e.to) err("self_loop", `Node "${e.from}" connects to itself`, e.from);
    if (!spec(e.from).ports.includes(e.port)) err("bad_port", `${spec(e.from).title} has no "${e.port}" output`, e.from);
    const key = `${e.from}:${e.port}`;
    if (seenPort.has(key)) err("duplicate_port", `"${e.port}" output of "${e.from}" is connected twice`, e.from);
    seenPort.add(key);
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }

  // Exactly one trigger, at the root.
  const triggers = nodes.filter((n) => SPEC_BY_TYPE[n.type].category === "trigger");
  if (triggers.length !== 1) err("trigger_count", `A workflow needs exactly one trigger (found ${triggers.length})`);
  const trigger = triggers[0];
  if (trigger && incoming.has(trigger.id)) err("trigger_incoming", "The trigger cannot have incoming connections", trigger.id);

  // Required ports and terminals.
  for (const n of nodes) {
    const s = SPEC_BY_TYPE[n.type];
    const used = new Set((out.get(n.id) ?? []).map((e) => e.port));
    for (const p of s.requiredPorts) if (!used.has(p)) err("missing_port", `${s.title} "${n.label ?? n.id}" has no "${p}" connection`, n.id);
    if (s.ports.length > 0 && used.size === 0) err("dead_end", `"${n.label ?? n.id}" leads nowhere; end it with an End node`, n.id);
    if (opts.forActivation && s.implementedIn > RUNTIME_PHASE) {
      err("not_available", `${s.title} runs from Phase ${s.implementedIn}; it can be drafted but not activated yet`, n.id);
    }
  }

  if (issues.some((i) => i.severity === "error") || !trigger) return { ok: false, graph, issues };

  // Topological order (also detects cycles).
  const order: string[] = [];
  const indeg = new Map(nodes.map((n) => [n.id, (incoming.get(n.id) ?? []).length]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of out.get(id) ?? []) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== nodes.length) {
    err("cycle", "The graph contains a loop; workflows must flow in one direction");
    return { ok: false, graph, issues };
  }

  // Reachability from the trigger.
  const reachable = new Set<string>([trigger.id]);
  for (const id of order) if (reachable.has(id)) for (const e of out.get(id) ?? []) reachable.add(e.to);
  for (const n of nodes) if (!reachable.has(n.id)) err("unreachable", `"${n.label ?? n.id}" can never run`, n.id);

  // Dominators: a node may only read outputs of nodes that ran on every path to it.
  const all = new Set(order);
  const dom = new Map<string, Set<string>>();
  for (const id of order) {
    const preds = (incoming.get(id) ?? []).map((e) => e.from).filter((p) => reachable.has(p));
    if (id === trigger.id || preds.length === 0) {
      dom.set(id, new Set([id]));
      continue;
    }
    let acc: Set<string> | undefined;
    for (const p of preds) {
      const d: Set<string> = dom.get(p) ?? all;
      acc = acc ? new Set([...acc].filter((x: string) => d.has(x))) : new Set(d);
    }
    const doms = acc ?? new Set<string>();
    doms.add(id);
    dom.set(id, doms);
  }

  for (const n of nodes) {
    const s = SPEC_BY_TYPE[n.type];
    for (const ref of nodeRefs(n, s)) {
      if (!ref.startsWith("nodes.")) continue;
      const src = ref.split(".")[1];
      if (!byId.has(src)) {
        err("bad_ref", `"${n.label ?? n.id}" reads ${ref}, but there is no node "${src}"`, n.id);
      } else if (src === n.id || !dom.get(n.id)?.has(src)) {
        err("ref_not_guaranteed", `"${n.label ?? n.id}" reads ${ref}, but "${src}" does not run on every path before it`, n.id);
      } else if ((s.movesMoney || s.external) && SPEC_BY_TYPE[byId.get(src)!.type].isAI) {
        err("ai_feeds_money", `"${n.label ?? n.id}" takes ${ref} straight from an AI node; AI output may only inform policy or condition nodes`, n.id);
      }
    }
  }

  // Money gate: no money-moving or external node may be reached without passing a policy or approval gate.
  const states = new Map<string, Set<boolean>>([[trigger.id, new Set([false])]]);
  for (const id of order) {
    const here = states.get(id);
    if (!here) continue;
    const s = spec(id);
    for (const gated of here) {
      if ((s.movesMoney || s.external) && !gated) {
        err("ungated_money", `"${byId.get(id)!.label ?? id}" can be reached without passing a policy or approval gate`, id);
      }
      for (const e of out.get(id) ?? []) {
        const passes = (s.isPolicy || byId.get(id)!.type === "control.approval") && GATE_PASS_PORTS[e.port] !== undefined;
        const next = states.get(e.to) ?? new Set<boolean>();
        next.add(gated || passes);
        states.set(e.to, next);
      }
    }
  }

  // Advisory checks.
  for (const n of nodes) {
    const s = SPEC_BY_TYPE[n.type];
    if ((s.movesMoney || s.external) && !(out.get(n.id) ?? []).some((e) => e.port === "error")) {
      warn("no_error_path", `"${n.label ?? n.id}" has no error path; a PayPal failure will fail the run`, n.id);
    }
  }

  const ok = !issues.some((i) => i.severity === "error");
  return ok ? { ok: true, graph, issues } : { ok: false, graph, issues };
}

/** Every reference a node's config reads. */
export function nodeRefs(n: GraphNode, s: NodeSpec = SPEC_BY_TYPE[n.type]): string[] {
  const refs: string[] = [];
  for (const k of s.refKeys ?? []) {
    const v = n.config[k];
    if (typeof v === "string") refs.push(v);
  }
  if (n.type === "control.condition" && n.config.expr) refs.push(...exprRefs(n.config.expr as Expr));
  if (n.type === "trigger.paypal_event" && n.config.filter) refs.push(...exprRefs(n.config.filter as Expr));
  if (n.type === "ai.purpose_classification" && Array.isArray(n.config.textRefs)) refs.push(...(n.config.textRefs as string[]));
  return refs;
}
