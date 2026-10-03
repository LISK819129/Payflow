"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useMemo } from "react";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import type { Issue } from "@/server/workflow/dsl/validate";
import { FlowNodeView, type FlowNode, type NodeRunState } from "./flow-node";
import { NODE_H, NODE_W } from "./layout";
import { SPEC_BY_TYPE } from "@/server/workflow/dsl/nodes";

/** Handle geometry matching FlowNodeView, so edges draw before the DOM is measured. */
function handlesFor(type: string) {
  const spec = SPEC_BY_TYPE[type];
  const ports = spec?.ports ?? [];
  const target = spec?.category === "trigger" ? [] : [{ type: "target" as const, position: Position.Top, x: NODE_W / 2 - 4, y: -4, width: 8, height: 8 }];
  return [
    ...target,
    ...ports.map((p, i) => ({ id: p, type: "source" as const, position: Position.Bottom, x: (NODE_W * (i + 1)) / (ports.length + 1) - 4, y: NODE_H - 4, width: 8, height: 8 })),
  ];
}

const nodeTypes = { pf: FlowNodeView };

export type RunOverlay = Record<string, { state: NodeRunState; port: string | null }>;

type Props = {
  graph: WorkflowGraph;
  positions: Record<string, { x: number; y: number }>;
  issues?: Issue[];
  selectedId?: string | null;
  run?: RunOverlay;
  /** Nodes to mark as new/changed (proposed edits). */
  highlight?: Record<string, "added" | "changed">;
  /** Progressive reveal: only these node ids are shown (edges appear once both ends are). */
  visible?: Set<string>;
  editable?: boolean;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, pos: { x: number; y: number }) => void;
  onConnect?: (c: Connection) => void;
  onDeleteNodes?: (ids: string[]) => void;
  onDeleteEdges?: (keys: string[]) => void;
};

export const edgeKey = (e: { from: string; port: string; to: string }) => `${e.from}:${e.port}:${e.to}`;

/**
 * The canvas. In a run view, the path the run actually took is re-stroked as a
 * moving fluorescent marker; untaken branches stay grey.
 */
export function GraphCanvas({ graph, positions, issues = [], selectedId, run, highlight, visible, editable, onSelect, onMove, onConnect, onDeleteNodes, onDeleteEdges }: Props) {
  const nodes: FlowNode[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: "pf" as const,
        position: positions[n.id] ?? { x: 0, y: 0 },
        selected: n.id === selectedId,
        draggable: !!editable,
        // Known size up front: edges can be drawn before the DOM is measured.
        // Progressive reveal: every node is laid out (so the view fits the whole graph) and fades in.
        style: visible ? { opacity: visible.has(n.id) ? 1 : 0, transition: "opacity var(--pf-dur-slow) var(--pf-ease)" } : undefined,
        initialWidth: NODE_W,
        initialHeight: NODE_H,
        handles: handlesFor(n.type),
        data: {
          node: n,
          issues: issues.filter((i) => i.nodeId === n.id && i.severity === "error").length,
          runState: run ? (run[n.id]?.state ?? "idle") : undefined,
          takenPort: run?.[n.id]?.port ?? null,
          highlight: highlight?.[n.id],
        },
      })),
    [graph.nodes, positions, issues, selectedId, run, editable, highlight, visible],
  );

  const edges: RFEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const shown = !visible || (visible.has(e.from) && visible.has(e.to));
        const travelled = !!run && run[e.from]?.port === e.port && !!run[e.to] && run[e.to].state !== "idle";
        const isError = e.port === "error";
        return {
          id: edgeKey(e),
          source: e.from,
          sourceHandle: e.port,
          target: e.to,
          type: "smoothstep",
          className: travelled ? "pf-edge-travelled" : undefined,
          style: {
            stroke: travelled ? "var(--pf-marker)" : isError ? "color-mix(in oklab, var(--pf-danger) 45%, white)" : "var(--pf-line-strong)",
            strokeWidth: travelled ? 3 : 1.5,
            strokeDasharray: isError && !travelled ? "4 4" : undefined,
            opacity: shown ? 1 : 0,
            transition: "opacity var(--pf-dur-slow) var(--pf-ease)",
          },
          markerEnd: shown ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: travelled ? "var(--pf-marker)" : "var(--pf-line-strong)" } : undefined,
        };
      }),
    [graph.edges, run, visible],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={!!editable}
      elementsSelectable
      deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
      onNodeClick={(_, n) => onSelect?.(n.id)}
      onPaneClick={() => onSelect?.(null)}
      onNodesChange={(changes: NodeChange<FlowNode>[]) => {
        for (const c of changes) if (c.type === "position" && c.position && !c.dragging) onMove?.(c.id, c.position);
        const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
        if (removed.length) onDeleteNodes?.(removed);
      }}
      onEdgesChange={(changes: EdgeChange[]) => {
        const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
        if (removed.length) onDeleteEdges?.(removed);
      }}
      onConnect={(c) => onConnect?.(c)}
      className="pf-canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--pf-line-strong)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
