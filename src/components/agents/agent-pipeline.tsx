import { Bot, Check, CircleAlert, CircleDashed, CircleX, Fingerprint, KeyRound, Landmark, Radio, ScanSearch, ShieldCheck, Stamp } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatClock, formatDay, formatMoney } from "@/components/ui";
import type { AgentRequestView } from "@/server/agents/queries";

type Tone = "ok" | "warn" | "stop" | "wait" | "skip";

const toneStyle: Record<Tone, { bar: string; text: string; icon: ReactNode }> = {
  ok: { bar: "border-marker", text: "text-marker-ink", icon: <Check size={14} strokeWidth={2.5} aria-label="passed" /> },
  warn: { bar: "border-warn", text: "text-warn", icon: <CircleAlert size={14} strokeWidth={2} aria-label="needs a person" /> },
  stop: { bar: "border-danger", text: "text-danger", icon: <CircleX size={14} strokeWidth={2} aria-label="stopped" /> },
  wait: { bar: "border-line-strong", text: "text-muted", icon: <CircleDashed size={14} strokeWidth={2} aria-label="not reached" /> },
  skip: { bar: "border-line", text: "text-faint", icon: <CircleDashed size={14} strokeWidth={2} aria-label="not needed" /> },
};

function Stage({ n, icon, title, verdict, tone, children }: { n: number; icon: ReactNode; title: string; verdict: string; tone: Tone; children: ReactNode }) {
  const t = toneStyle[tone];
  return (
    <li className={`relative min-w-0 border-t-[3px] ${t.bar} bg-surface px-3.5 pb-4 pt-3`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 pf-label text-ink">
          <span className="text-muted">{icon}</span>
          {title}
        </span>
        <span className="font-mono text-[10px] text-faint">{String(n).padStart(2, "0")}</span>
      </div>
      <div className={`mt-2 inline-flex items-center gap-1 text-body-sm font-semibold uppercase tracking-[0.04em] ${t.text}`}>
        {t.icon}
        {verdict}
      </div>
      <div className="mt-1.5 space-y-0.5 text-meta leading-snug text-ink-2">{children}</div>
    </li>
  );
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * The agent's path through PayFlow, left to right:
 * request → identity → scope → intent receipt → authority → intelligence → person → PayPal.
 */
export function AgentPipeline({ v, showRunLink = false }: { v: AgentRequestView; showRunLink?: boolean }) {
  const { ar, receipt, status, verification, intelligence, agent } = v;
  const r = receipt.request;
  const test = ar.mode === "TEST";
  const dec = status.authority?.decision ?? null;
  const ap = status.human_review;
  const reasons = status.reasons.filter((x) => x.code !== "WITHDRAWN");
  const scopeOk = true; // a request only exists if identity and scope passed
  const aiTone: Tone = !intelligence.length
    ? status.state === "ACCEPTED" || status.state === "PROCESSING"
      ? "wait"
      : "skip"
    : intelligence.some((i) => ["OUTSIDE_SCOPE", "MISMATCH", "HIGH"].includes(String(i.verdict)) || i.injection)
      ? "stop"
      : intelligence.some((i) => ["UNCERTAIN", "ELEVATED", "UNAVAILABLE"].includes(String(i.verdict)))
        ? "warn"
        : "ok";

  const authority: [Tone, string] = test
    ? ["skip", "see test result"]
    : dec === "ALLOW" || status.authority?.outcome === "ALLOW_AFTER_HUMAN_APPROVAL"
      ? ["ok", status.authority?.outcome === "ALLOW_AFTER_HUMAN_APPROVAL" || ap?.status === "APPROVED" ? "allow after approval" : "allow"]
      : dec === "REVIEW"
        ? ["warn", "review"]
        : dec === "DENY"
          ? ["stop", "deny"]
          : status.state === "DENIED"
            ? ["stop", "blocked"]
            : ["wait", "pending"];

  const person: [Tone, string] = test
    ? ["skip", "never in a test"]
    : !ap?.required
      ? dec
        ? ["skip", "not needed"]
        : ["wait", "—"]
      : ap.status === "PENDING"
        ? ["warn", "waiting"]
        : ap.status === "APPROVED"
          ? ["ok", "approved once"]
          : ["stop", status.state === "CANCELLED" ? (status.reasons.some((x) => x.code === "AGENT_REVOKED") ? "withdrawn: agent revoked" : "withdrawn") : ap.status === "EXPIRED" ? "expired" : "rejected"];

  const st = status.paypal.settlement;
  const paypal: [Tone, string] = test
    ? ["skip", "cannot be reached"]
    : st
      ? [st.stage === "SETTLED" || st.stage === "DONE" ? "ok" : st.stage === "FAILED" || st.stage === "RETURNED" ? "stop" : "warn", st.label.toLowerCase()]
      : status.state === "FAILED"
        ? ["stop", "refused"]
        : status.state === "UNKNOWN"
          ? ["warn", "unknown"]
          : ["skip", "not contacted"];

  return (
    <section aria-label="Agent request pipeline">
      <ol className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
        <Stage n={1} icon={<Bot size={13} aria-hidden />} title="Agent request" verdict={test ? "test" : "received"} tone="ok">
          <div className="font-mono text-ink">{ar.reference}</div>
          <div className="truncate font-mono">id {ar.requestId}</div>
          <div>
            {formatDay(ar.createdAt)} {formatClock(ar.createdAt)} · MCP
          </div>
        </Stage>
        <Stage n={2} icon={<KeyRound size={13} aria-hidden />} title="Identity" verdict="verified" tone="ok">
          <div className="text-ink">{agent.name}</div>
          <div>bearer credential v{receipt.requester.credential_version}</div>
          <div className="truncate">owner {v.ownerEmail}</div>
        </Stage>
        <Stage n={3} icon={<ShieldCheck size={13} aria-hidden />} title="Scope" verdict={scopeOk ? "allowed to ask" : "refused"} tone="ok">
          <div>
            may request <span className="text-ink">{r.action.replace("paypal.", "")}</span>
          </div>
          <div className="truncate">via {receipt.workflow.name} v{receipt.workflow.version}</div>
          <div className="text-muted">asking ≠ authority</div>
        </Stage>
        <Stage n={4} icon={<Fingerprint size={13} aria-hidden />} title="Intent receipt" verdict={verification.ok ? "intact" : "tampered"} tone={verification.ok ? "ok" : "stop"}>
          <div className="text-ink">
            {r.amount.value} {r.amount.currency} → {r.counterparty ?? r.capture_id}
          </div>
          <div className="font-mono">{short(ar.receiptHash)}</div>
          <div>
            {verification.links} link{verification.links === 1 ? "" : "s"} · audit-anchored
          </div>
        </Stage>
        <Stage n={5} icon={<Landmark size={13} aria-hidden />} title="Authority" verdict={authority[1]} tone={authority[0]}>
          {status.authority?.authorities.map((a) => (
            <div key={a.id} className="truncate">
              {a.name} v{a.version}
            </div>
          ))}
          {reasons.slice(0, 3).map((x) => (
            <div key={x.code} className="break-all font-mono text-[11px] text-ink">
              {x.code}
            </div>
          ))}
        </Stage>
        <Stage n={6} icon={<ScanSearch size={13} aria-hidden />} title="Intelligence" verdict={aiTone === "ok" ? "consistent" : aiTone === "stop" ? "flagged" : aiTone === "warn" ? "uncertain" : aiTone === "skip" ? "not reached" : "pending"} tone={aiTone}>
          {intelligence.map((i) => (
            <div key={i.task} className="flex justify-between gap-2">
              <span>{i.task}</span>
              <span className="font-mono text-[11px] text-ink">{String(i.verdict).replaceAll("_", " ")}</span>
            </div>
          ))}
          {intelligence.some((i) => i.injection) && <div className="text-danger">instructions in untrusted text</div>}
        </Stage>
        <Stage n={7} icon={<Stamp size={13} aria-hidden />} title="Human approval" verdict={person[1]} tone={person[0]}>
          {ap?.required ? <div>{ap.decided_at ? `decided ${ap.decided_at.slice(11, 16)} UTC` : "an agent cannot approve"}</div> : <div>{test ? "assumptions only, in TEST" : "within delegated authority"}</div>}
        </Stage>
        <Stage n={8} icon={<Radio size={13} aria-hidden />} title="PayPal" verdict={paypal[1]} tone={paypal[0]}>
          {status.paypal.ids.map((id) => (
            <div key={id} className="font-mono text-ink">
              {id}
            </div>
          ))}
          <div>{status.paypal.submitted ? `${formatMoney(r.amount.value, r.amount.currency)} · Sandbox` : test ? "no capability in TEST" : "nothing sent"}</div>
          {st && <div>{st.paypal_status ? `PayPal: ${st.paypal_status}` : ""}</div>}
          {status.paypal.confirmed_by_webhook && <div>confirmed by webhook</div>}
        </Stage>
      </ol>
      {showRunLink && ar.runId && (
        <Link href={`/executions/${ar.runId}`} className="mt-3 inline-block text-body-sm text-muted hover:text-ink">
          Open the workflow run →
        </Link>
      )}
    </section>
  );
}

/** Black banner at the top of anything an agent asked for. */
export function AgentBanner({ v }: { v: AgentRequestView }) {
  const test = v.ar.mode === "TEST";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="inline-flex items-center gap-2 bg-ink px-2.5 py-1 text-label font-semibold uppercase tracking-[0.08em] text-surface">
        <Bot size={13} aria-hidden /> {test ? "TEST request by AI agent — cannot move money" : "Requested by AI agent"}
      </span>
      <Link href={`/agents/${v.agent.id}`} className="text-body font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
        {v.agent.name}
      </Link>
      <span className="font-mono text-meta text-muted">
        {v.ar.reference} · state {v.status.state}
      </span>
    </div>
  );
}
