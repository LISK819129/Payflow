"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { useMemo } from "react";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { GraphCanvas, type RunOverlay } from "./graph-canvas";
import { layoutGraph } from "./layout";

/** Read-only canvas showing the path a run took, drawn in marker cyan. */
export function RunGraph({ graph, overlay }: { graph: WorkflowGraph; overlay: RunOverlay }) {
  const positions = useMemo(() => layoutGraph(graph), [graph]);
  return (
    <ReactFlowProvider>
      <GraphCanvas graph={graph} positions={positions} run={overlay} />
    </ReactFlowProvider>
  );
}
