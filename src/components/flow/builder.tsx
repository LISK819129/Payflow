"use client";

import type { Connection } from "@xyflow/react";
import { ReactFlowProvider } from "@xyflow/react";
import { CircleAlert, CircleCheck, Eye, FlaskConical, LayoutGrid, Pause, Play, Rocket, Save, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { activateAction, manualRunAction, saveDraftAction, setStateAction } from "@/app/(app)/flows/actions";
import { setObservingAction } from "@/app/(app)/simulations/actions";
import { TestRunDialog } from "@/components/simulation/test-run-dialog";
import type { TestExample } from "@/server/demo/setup";
import { Button, ProvenanceTag } from "@/components/ui";
import { canonicalJson } from "@/server/audit/canonical-json";
import { NODE_SPECS, SPEC_BY_TYPE, type GraphNode, type WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { RUNTIME_PHASE, validateGraph, type Issue } from "@/server/workflow/dsl/validate";
import { edgeKey, GraphCanvas } from "./graph-canvas";
import { Inspector } from "./inspector";
import { RulePanel } from "./rule-panel";
import type { AuthorityTerms } from "@/server/workflow/rule-summary";
import { layoutGraph } from "./layout";
import { PatchBar } from "./patch-bar";

type Props = {
  workflowId: string;
  name: string;
  state: string;
  latestVersion: number;
  latestStatus: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  activeVersion: number | null;
  initialGraph: WorkflowGraph;
  canAuthorize: boolean;
  aiConfigured: boolean;
  provenance: string;
  aiInstruction?: string | null;
  observing?: boolean;
  observations?: number;
  /** Open the Test run straight away (from the home page / guide). */
  autoTest?: boolean;
  suppliers?: { id: string; name: string }[];
  testExamples?: TestExample[];
  /** Authorities covering this workflow, and how many agents may ask through it — for the "This rule" summary. */
  authorities?: AuthorityTerms[];
  agentCount?: number;
  isOwner?: boolean;
};

const CATEGORY_ORDER = ["trigger", "policy", "control", "paypal", "ai", "ledger"] as const;
const CATEGORY_TITLE: Record<string, string> = { trigger: "Triggers", policy: "Policy", control: "Control", paypal: "PayPal actions", ai: "Intelligence", ledger: "Ledger" };

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "trigger.paypal_event":
      return { eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] };
    case "trigger.schedule":
      return { cron: "0 9 * * *", timezone: "UTC" };
    case "control.condition":
      return { expr: { op: "gt", left: { ref: "trigger.amount" }, right: { const: "0" } } };
    case "control.approval":
      return { reason: "Needs a person to check", amountRef: "trigger.amount" };
    case "control.delay":
      return { minutes: 60 };
    case "control.freeze":
      return { reason: "Related payment disputed or refunded", includeDependents: true };
    case "control.terminal":
      return { outcome: "completed", message: "Done" };
    case "policy.amount_limit":
      return { amountRef: "trigger.amount", max: { value: "500.00", currency: "USD" } };
    case "policy.currency":
      return { amountRef: "trigger.amount", allowed: ["USD"] };
    case "policy.counterparty":
      return { ref: "trigger.payer.email", allowed: [] };
    case "paypal.refund":
      return { captureIdRef: "trigger.resourceId", amountRef: "trigger.amount", note: "Refund via PayFlow" };
    case "paypal.payout":
      return { receiverRef: "trigger.supplierEmail", amountRef: "trigger.amount", note: "Payment via PayFlow" };
    case "paypal.order_capture":
      return { orderIdRef: "trigger.resourceId", amountRef: "trigger.amount" };
    case "paypal.invoice_send":
      return { recipientRef: "trigger.clientEmail", amountRef: "trigger.amount", description: "Services" };
    case "paypal.invoice_remind":
      return { invoiceIdRef: "trigger.invoiceId", subject: "Friendly reminder" };
    case "paypal.fetch":
      return { resource: "capture", idRef: "trigger.resourceId" };
    case "paypal.transaction_search":
      return { days: 7 };
    case "ledger.reconcile":
      return { paymentRef: "trigger.amount", invoiceIdRef: "trigger.invoiceId" };
    case "ai.invoice_extract":
      return { documentRef: "trigger.invoice", amountRef: "trigger.amount" };
    case "ai.purpose_classification":
      return { textRefs: ["trigger.invoice"], amountRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail", action: "paypal.payout" };
    case "ai.behavior_analysis":
      return { paymentRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail", descriptionRef: "trigger.invoice", action: "paypal.payout", explain: "when_flagged" };
    case "ai.contract_match":
      return { invoiceRef: "trigger.invoice", contractRef: "trigger.contract", amountRef: "trigger.amount", counterpartyRef: "trigger.supplierEmail" };
    case "ai.invoice_match":
      return { paymentRef: "trigger.amount", counterpartyRef: "trigger.payer.email" };
    case "policy.frequency":
      return { max: 20, period: "day", key: "payments" };
    default:
      return {};
  }
}

export function FlowBuilder(props: Props) {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  );
}

function Builder({ workflowId, name, state, latestVersion, latestStatus, activeVersion, initialGraph, canAuthorize, aiConfigured, provenance, aiInstruction, observing = false, observations = 0, autoTest = false, suppliers = [], testExamples = [], authorities = [], agentCount = 0, isOwner = false }: Props) {
  const [testOpen, setTestOpen] = useState(autoTest && canAuthorize);
  const [observeOn, setObserveOn] = useState(observing);
  const router = useRouter();
  const [graph, setGraph] = useState<WorkflowGraph>(initialGraph);
  const [positions, setPositions] = useState(() => layoutGraph(initialGraph));
  const [savedHash, setSavedHash] = useState(() => canonicalJson({ n: initialGraph.nodes, e: initialGraph.edges, l: layoutGraph(initialGraph) }));
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<Issue[] | null>(null);
  const [pending, start] = useTransition();
  const [runOpen, setRunOpen] = useState(false);

  const validation = useMemo(() => validateGraph(graph, { forActivation: true }), [graph]);
  const issues = serverIssues ?? validation.issues;
  const errors = issues.filter((i) => i.severity === "error");
  const dirty = canonicalJson({ n: graph.nodes, e: graph.edges, l: positions }) !== savedHash;
  const editingActive = latestStatus !== "DRAFT";

  const update = (g: WorkflowGraph) => {
    setGraph(g);
    setServerIssues(null);
  };
  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;

  const addNode = (type: string) => {
    const base = type.split(".").pop()!.replace(/[^a-z_]/g, "") || "node";
    let i = 1;
    while (graph.nodes.some((n) => n.id === `${base}${i}`)) i++;
    const id = `${base}${i}`;
    const anchor = selected ? positions[selected] : Object.values(positions).at(-1);
    update({ ...graph, nodes: [...graph.nodes, { id, type, config: defaultConfig(type) }] });
    setPositions({ ...positions, [id]: { x: (anchor?.x ?? 0) + 40, y: (anchor?.y ?? 0) + 120 } });
    setSelected(id);
  };

  const connect = (c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle) return;
    // One edge per output port: a new connection replaces the old one.
    const edges = graph.edges.filter((e) => !(e.from === c.source && e.port === c.sourceHandle));
    update({ ...graph, edges: [...edges, { from: c.source, to: c.target, port: c.sourceHandle }] });
  };

  const save = () =>
    start(async () => {
      const g: WorkflowGraph = { ...graph, layout: positions };
      const r = await saveDraftAction(workflowId, g);
      if (r.ok) {
        setSavedHash(canonicalJson({ n: graph.nodes, e: graph.edges, l: positions }));
        setFlash({ tone: "ok", text: r.message ?? "Saved" });
        router.refresh();
      } else {
        setServerIssues(r.issues ?? null);
        setFlash({ tone: "danger", text: r.error });
      }
    });

  const activate = () =>
    start(async () => {
      const r = await activateAction(workflowId);
      if (r.ok) {
        setFlash({ tone: "ok", text: r.message ?? "Activated" });
        router.refresh();
      } else {
        setServerIssues(r.issues ?? null);
        setFlash({ tone: "danger", text: r.error });
      }
    });

  const setState = (to: "PAUSED" | "ACTIVE") =>
    start(async () => {
      const r = await setStateAction(workflowId, to);
      setFlash(r.ok ? { tone: "ok", text: r.message ?? to } : { tone: "danger", text: r.error });
      router.refresh();
    });

  const grouped = CATEGORY_ORDER.map((cat) => ({ cat, specs: NODE_SPECS.filter((s) => s.category === cat) }));

  return (
    <div className="flex h-[calc(100vh-64px)] min-h-[620px] flex-col md:h-screen">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold tracking-[-0.01em]">{name}</h1>
          <div className="flex items-center gap-2 text-meta text-muted">
            <span className="pf-label">{state.toLowerCase()}</span>
            <span>·</span>
            <span>
              editing v{latestVersion}
              {editingActive ? " (active — saving creates a new draft)" : " draft"}
            </span>
            {activeVersion && activeVersion !== latestVersion && <span>· v{activeVersion} active</span>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {validation.ok && errors.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-body-sm text-ok">
              <CircleCheck size={14} aria-hidden /> Valid
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-body-sm text-danger">
              <CircleAlert size={14} aria-hidden /> {errors.length} problem{errors.length === 1 ? "" : "s"}
            </span>
          )}
          <Button size="sm" variant="quiet" onClick={() => setPositions(layoutGraph(graph, true))} title="Tidy layout">
            <LayoutGrid size={14} aria-hidden /> Tidy
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            <Save size={14} aria-hidden /> {dirty ? "Save draft" : "Saved"}
          </Button>
          {canAuthorize && (latestStatus === "DRAFT" || dirty) ? (
            <Button
              size="sm"
              variant="primary"
              onClick={activate}
              disabled={pending || dirty || latestStatus !== "DRAFT" || errors.length > 0 || state === "FROZEN"}
              title={dirty ? "Save first" : undefined}
            >
              <Rocket size={14} aria-hidden /> Activate v{latestVersion}
            </Button>
          ) : (
            activeVersion !== null && <span className="text-body-sm text-muted">v{activeVersion} is active</span>
          )}
          {canAuthorize && state === "ACTIVE" && (
            <Button size="sm" variant="quiet" onClick={() => setState("PAUSED")} disabled={pending}>
              <Pause size={14} aria-hidden /> Pause
            </Button>
          )}
          {canAuthorize && (state === "PAUSED" || state === "FROZEN") && (
            <Button size="sm" onClick={() => setState("ACTIVE")} disabled={pending}>
              <Play size={14} aria-hidden /> {state === "FROZEN" ? "Unfreeze" : "Resume"}
            </Button>
          )}
          {canAuthorize && state === "ACTIVE" && (
            <Button size="sm" variant="quiet" onClick={() => setRunOpen(true)} disabled={pending}>
              <Play size={14} aria-hidden /> Run manually
            </Button>
          )}
          {canAuthorize && (
            <Button size="sm" onClick={() => setTestOpen(true)} disabled={pending || dirty} title={dirty ? "Save first: a test runs the saved version" : "See what PayFlow would decide for a request — PayPal is not contacted, no money moves"}>
              <FlaskConical size={14} aria-hidden /> Test run
            </Button>
          )}
          {canAuthorize && latestStatus === "DRAFT" && (
            <Button
              size="sm"
              variant="quiet"
              disabled={pending}
              title="Watch real PayPal events with this draft — it cannot move money or contact anyone"
              onClick={() =>
                start(async () => {
                  const r = await setObservingAction(workflowId, !observeOn);
                  if (r.ok) setObserveOn(!observeOn);
                })
              }
            >
              {observeOn ? <span aria-hidden className="animate-live-dot mx-[3px] inline-block size-2 rounded-full bg-marker" /> : <Eye size={14} aria-hidden />}
              {observeOn ? "Observing" : "Observe"}
            </Button>
          )}
          {(observeOn || observations > 0) && (
            <Link href={`/flows/${workflowId}/observations`} className="text-body-sm text-muted hover:text-ink">
              {observations} observed
            </Link>
          )}
        </div>
      </header>

      {testOpen && <TestRunDialog workflowId={workflowId} graph={graph} suppliers={suppliers} examples={testExamples} onClose={() => setTestOpen(false)} />}
      <PatchBar workflowId={workflowId} aiConfigured={aiConfigured} disabledReason={dirty ? "Save your manual edits before asking for an AI change" : canAuthorize ? undefined : "Only owners and approvers can edit"} />

      {provenance === "AI_GENERATED" && aiInstruction && (
        <div className="flex items-center gap-3 border-b border-line bg-surface px-5 py-2 text-body-sm text-muted">
          <ProvenanceTag value="AI_GENERATED" />
          <span className="truncate" title={aiInstruction}>
            v{latestVersion} compiled from: “{aiInstruction}”
          </span>
        </div>
      )}

      {flash && (
        <div className={`flex items-center gap-2 border-b px-5 py-2 text-body-sm ${flash.tone === "ok" ? "border-line bg-ok-wash text-ok" : "border-line bg-danger-wash text-danger"}`} role="status">
          {flash.text}
          <button className="ml-auto" onClick={() => setFlash(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Node library */}
        <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-line bg-surface px-3 py-4 lg:block" aria-label="Node library">
          {grouped.map(({ cat, specs }) => (
            <div key={cat} className="mb-5">
              <div className="pf-label mb-1.5 px-1">{CATEGORY_TITLE[cat]}</div>
              {specs.map((s) => {
                const available = s.implementedIn <= RUNTIME_PHASE;
                return (
                  <button
                    key={s.type}
                    onClick={() => available && addNode(s.type)}
                    disabled={!available}
                    title={available ? s.description : `Arrives in Phase ${s.implementedIn}`}
                    className="flex w-full items-center justify-between rounded-sm px-1.5 py-1 text-left text-body-sm text-ink-2 hover:bg-sunken disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent"
                  >
                    <span className="truncate">{s.title}</span>
                    {!available && <span className="font-mono text-[10px]">P{s.implementedIn}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1 bg-canvas">
          <GraphCanvas
            graph={graph}
            positions={positions}
            issues={issues}
            selectedId={selected}
            editable
            onSelect={setSelected}
            onMove={(id, pos) => setPositions((p) => ({ ...p, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } }))}
            onConnect={connect}
            onDeleteNodes={(ids) => {
              update({ ...graph, nodes: graph.nodes.filter((n) => !ids.includes(n.id)), edges: graph.edges.filter((e) => !ids.includes(e.from) && !ids.includes(e.to)) });
              setSelected(null);
            }}
            onDeleteEdges={(keys) => update({ ...graph, edges: graph.edges.filter((e) => !keys.includes(edgeKey(e))) })}
          />
        </div>

        {/* Inspector / problems */}
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-surface px-5 py-5" aria-label="Inspector">
          {selectedNode ? (
            <Inspector
              key={selectedNode.id}
              node={selectedNode}
              issues={issues.filter((i) => i.nodeId === selectedNode.id)}
              readOnly={false}
              onChange={(n: GraphNode) => update({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? n : x)) })}
              onDelete={() => {
                update({ ...graph, nodes: graph.nodes.filter((n) => n.id !== selectedNode.id), edges: graph.edges.filter((e) => e.from !== selectedNode.id && e.to !== selectedNode.id) });
                setSelected(null);
              }}
            />
          ) : (
            <div>
              <RulePanel
                workflowId={workflowId}
                workflowName={name}
                graph={graph}
                state={state}
                latestStatus={latestStatus}
                latestVersion={latestVersion}
                authorities={authorities}
                agentCount={agentCount}
                isOwner={isOwner}
                onTest={() => setTestOpen(true)}
              />
              <div className="pf-label">Validation</div>
              {issues.length === 0 ? (
                <p className="mt-2 text-body-sm text-ok">No problems. Every money path passes a policy or approval gate.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {issues.map((i, k) => (
                    <li key={k}>
                      <button
                        className={`text-left text-body-sm ${i.severity === "error" ? "text-danger" : "text-warn"} hover:underline`}
                        onClick={() => i.nodeId && setSelected(i.nodeId)}
                      >
                        {i.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-6 text-meta text-muted">Select a node to edit it. Drag from a node&apos;s bottom handles to connect an output.</p>
            </div>
          )}
        </aside>
      </div>

      {runOpen && <ManualRunDialog workflowId={workflowId} graph={graph} onClose={() => setRunOpen(false)} />}
    </div>
  );
}

/** Fields the graph reads from `trigger.*`, as an empty payload to fill in. */
function manualExample(graph: WorkflowGraph): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (v: unknown, field: string) => {
    if (typeof v === "string") {
      const m = /^trigger\.([A-Za-z0-9_]+)/.exec(v);
      if (m && !(m[1] in out)) out[m[1]] = /amount|payment/i.test(field) ? { value: "", currency_code: "USD" } : "";
    } else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => visit(x, k));
  };
  graph.nodes.forEach((n) => visit(n.config, ""));
  return out;
}

function ManualRunDialog({ workflowId, graph, onClose }: { workflowId: string; graph: WorkflowGraph; onClose: () => void }) {
  const router = useRouter();
  const t = graph.nodes.find((n) => SPEC_BY_TYPE[n.type]?.category === "trigger");
  const example =
    t?.type === "trigger.paypal_event"
      ? { amount: { value: "4000.00", currency_code: "USD" }, payer: { email: "ap@novalabs.test" }, resourceId: "MANUAL-TEST" }
      : manualExample(graph);
  const [payload, setPayload] = useState(JSON.stringify(example, null, 2));
  // One key per dialog: a double click or a replayed submit resolves to the same run.
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4" role="dialog" aria-modal="true" aria-labelledby="run-title">
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-pop">
        <h2 id="run-title" className="text-title font-semibold">
          Run manually
        </h2>
        <p className="mt-1 text-body-sm text-muted">
          The payload becomes <span className="font-mono">trigger</span>. Runs started here are labelled <strong>user-provided</strong>, never PayPal activity.
        </p>
        <textarea aria-label="Run payload (JSON)" className="mt-4 h-48 w-full rounded-sm border border-field bg-surface p-2 font-mono text-meta outline-none focus:border-ink" value={payload} onChange={(e) => setPayload(e.target.value)} />
        {error && <p className="mt-2 text-body-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await manualRunAction(workflowId, payload, submissionKey);
                if (r.ok && r.runId) router.push(`/executions/${r.runId}`);
                else setError(r.ok ? "Started" : r.error);
              })
            }
          >
            Start run
          </Button>
        </div>
      </div>
    </div>
  );
}
