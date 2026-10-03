import type { WireOp } from "../../ai/types";
import type { WorkflowGraph } from "../dsl/nodes";
import { wireToNode } from "./convert";

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Applies patch operations to a copy of the graph, all-or-nothing. Paths are
 * plain dotted keys into a node's config; values are parsed JSON. Nothing is
 * evaluated. Any problem aborts the whole patch so a half-applied edit can't
 * reach the validator.
 */
export function applyOps(graph: WorkflowGraph, ops: WireOp[]): { ok: true; graph: WorkflowGraph } | { ok: false; problems: string[] } {
  const g: WorkflowGraph = structuredClone({ schemaVersion: 1, nodes: graph.nodes, edges: graph.edges, layout: graph.layout });
  const problems: string[] = [];
  const node = (id: string) => g.nodes.find((n) => n.id === id);

  ops.forEach((op, i) => {
    const where = `operation ${i + 1} (${op.op})`;
    switch (op.op) {
      case "set_config": {
        const n = node(op.node_id);
        if (!n) return void problems.push(`${where}: no node "${op.node_id}"`);
        const keys = op.path.split(".").filter(Boolean);
        if (keys.length === 0 || keys.some((k) => FORBIDDEN.has(k))) return void problems.push(`${where}: invalid path "${op.path}"`);
        let value: unknown;
        try {
          value = JSON.parse(op.value_json);
        } catch {
          return void problems.push(`${where}: value_json is not valid JSON`);
        }
        let cur: Record<string, unknown> = n.config;
        for (const k of keys.slice(0, -1)) {
          const nextVal = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
          if (nextVal === undefined) cur[k] = {};
          else if (typeof nextVal !== "object" || nextVal === null || Array.isArray(nextVal)) return void problems.push(`${where}: "${k}" in ${op.path} is not an object`);
          cur = cur[k] as Record<string, unknown>;
        }
        cur[keys.at(-1)!] = value;
        return;
      }
      case "set_label": {
        const n = node(op.node_id);
        if (!n) return void problems.push(`${where}: no node "${op.node_id}"`);
        n.label = op.label.trim() || undefined;
        return;
      }
      case "add_node": {
        if (node(op.node.id)) return void problems.push(`${where}: node id "${op.node.id}" already exists`);
        const n = wireToNode(op.node, problems);
        if (n) g.nodes.push(n);
        return;
      }
      case "remove_node": {
        if (!node(op.node_id)) return void problems.push(`${where}: no node "${op.node_id}"`);
        g.nodes = g.nodes.filter((n) => n.id !== op.node_id);
        g.edges = g.edges.filter((e) => e.from !== op.node_id && e.to !== op.node_id);
        if (g.layout) delete g.layout[op.node_id];
        return;
      }
      case "connect": {
        if (!node(op.from) || !node(op.to)) return void problems.push(`${where}: connects missing node ${op.from} → ${op.to}`);
        g.edges = g.edges.filter((e) => !(e.from === op.from && e.port === op.port));
        g.edges.push({ from: op.from, port: op.port, to: op.to });
        return;
      }
      case "disconnect": {
        const before = g.edges.length;
        g.edges = g.edges.filter((e) => !(e.from === op.from && e.port === op.port));
        if (g.edges.length === before) problems.push(`${where}: ${op.from}.${op.port} was not connected`);
        return;
      }
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, graph: g };
}
