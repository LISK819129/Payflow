import { Calculator, CircleAlert, CircleCheck, CircleHelp, CircleX, ShieldAlert, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { Evaluation } from "@/server/authority/types";
import type { AINodeOutput } from "@/server/intelligence/node";

type Analysis = { id: string; model: string; promptVersion: string; costUsd: string | null; hits: number; validation: unknown };

const sev = {
  ok: { icon: <CircleCheck size={14} strokeWidth={1.75} aria-hidden />, cls: "text-ink-2" },
  warn: { icon: <CircleAlert size={14} strokeWidth={1.75} aria-hidden />, cls: "text-warn" },
  bad: { icon: <CircleX size={14} strokeWidth={1.75} aria-hidden />, cls: "text-danger" },
  unknown: { icon: <CircleHelp size={14} strokeWidth={1.75} aria-hidden />, cls: "text-muted" },
};

function Row({ label, value, tone, detail }: { label: string; value: ReactNode; tone: keyof typeof sev; detail?: string }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 py-1.5">
      <dt className="text-body-sm text-muted">{label}</dt>
      <dd className={`text-body-sm ${sev[tone].cls}`}>
        <span className="inline-flex items-start gap-1.5">
          <span className="mt-[2px] shrink-0">{sev[tone].icon}</span>
          <span>
            <span className="font-mono font-medium">{value}</span>
            {detail && <span className="block text-meta text-muted">{detail}</span>}
          </span>
        </span>
      </dd>
    </div>
  );
}

const toneOf = (s: string): keyof typeof sev => (s === "high" ? "bad" : s === "elevated" ? "warn" : s === "info" ? "unknown" : "ok");

/**
 * What PayFlow knew before acting. Left: facts PayFlow calculated from its own
 * records. Right: interpretations an AI produced from the documents — labelled
 * as such, with model and provenance, never presented as fact. Below: why the
 * authority engine paused, in its own words.
 */
export function IntelligencePanel({ outputs, analyses, decision }: { outputs: AINodeOutput[]; analyses: Analysis[]; decision: { evaluations: Evaluation[]; outcome: string } | null }) {
  if (outputs.length === 0) return null;
  const risk = outputs.find((o) => o.task === "behavior");
  const purpose = outputs.find((o) => o.task === "purpose");
  const contract = outputs.find((o) => o.task === "contract");
  const extract = outputs.find((o) => o.task === "extract");
  const injected = outputs.filter((o) => o.injection?.detected);
  const aiUsed = outputs.filter((o) => o.source === "ai" && o.analysisId);
  const cost = aiUsed.reduce((t, o) => t + Number(analyses.find((a) => a.id === o.analysisId)?.costUsd ?? 0), 0);
  const noticed = (decision?.evaluations ?? []).filter((e) => e.result !== "pass" && ["purpose", "risk", "contract", "injection", "extraction"].includes(e.check));

  return (
    <section aria-labelledby="intel-h" className="border-t-2 border-ink bg-surface px-6 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="intel-h" className="pf-label text-ink">
          Intelligence
        </h2>
        <div className="font-mono text-meta text-muted">
          {aiUsed.length
            ? `${aiUsed.length} AI ${aiUsed.length === 1 ? "analysis" : "analyses"} · ${[...new Set(aiUsed.map((o) => o.model))].join(", ")} · ${aiUsed.filter((o) => o.cached).length} from cache · $${cost.toFixed(6)}`
            : "no AI call was needed"}
        </div>
      </div>

      <div className="mt-5 grid gap-x-10 gap-y-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.06em] text-ink">
            <Calculator size={13} aria-hidden /> Calculated by PayFlow
          </h3>
          <p className="mb-2 text-meta text-muted">From PayFlow&apos;s own payment records, by fixed rules.</p>
          <dl className="divide-y divide-line border-y border-line">
            {risk?.risk?.signals.map((s) => (
              <Row key={s.id} label={s.label} value={s.value} tone={toneOf(s.severity)} detail={s.detail} />
            ))}
            {risk?.risk && <Row label="Risk level" value={risk.risk.deterministicLevel} tone={risk.risk.deterministicLevel === "HIGH" ? "bad" : risk.risk.deterministicLevel === "LOW" ? "ok" : "warn"} detail="highest signal; the AI may raise it, never lower it" />}
            <Row
              label="Instruction scan"
              value={injected.length ? `${[...new Set(injected.flatMap((o) => o.injection.patterns.map((p) => p.pattern)))].length || 1} pattern(s)` : "clean"}
              tone={injected.length ? "bad" : "ok"}
              detail={injected.length ? injected.flatMap((o) => o.injection.patterns.map((p) => `“${p.excerpt}”`)).slice(0, 2).join(" · ") : "no text tries to instruct the AI"}
            />
            {extract?.extraction?.conflicts.map((c) => (
              <Row key={c.field} label={`${c.field} conflict`} value={`${c.source} ≠ ${c.document}`} tone="bad" detail="request vs document" />
            ))}
          </dl>
          {extract?.extraction && (
            <div className="mt-4">
              <div className="pf-label mb-1">Invoice fields</div>
              <ul className="space-y-0.5 text-body-sm">
                {Object.entries(extract.extraction.fields).map(([k, f]) => (
                  <li key={k} className="grid grid-cols-[110px_minmax(0,1fr)_auto] gap-2">
                    <span className="text-muted">{k}</span>
                    <span className="truncate font-mono text-meta">{f.value ?? "—"}</span>
                    <span className={`text-label font-semibold uppercase tracking-[0.06em] ${f.provenance === "AI_EXTRACTED" ? "text-marker-ink" : f.provenance === "SOURCE_PROVIDED" ? "text-ink-2" : "text-faint"}`}>
                      {f.provenance === "AI_EXTRACTED" ? "AI extracted" : f.provenance === "SOURCE_PROVIDED" ? "Source provided" : "Not found"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-1 inline-flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.06em] text-marker-ink">
            <Sparkles size={13} aria-hidden /> AI interpretation — not fact
          </h3>
          <p className="mb-2 text-meta text-muted">Evidence for the policy engine and for you. It cannot approve anything.</p>
          <dl className="divide-y divide-line border-y border-line">
            {purpose && (
              <Row
                label="Purpose"
                value={(purpose.classification ?? "UNCERTAIN").replaceAll("_", " ")}
                tone={purpose.classification === "WITHIN_SCOPE" ? "ok" : purpose.classification === "OUTSIDE_SCOPE" ? "bad" : "warn"}
                detail={[purpose.purpose?.category, purpose.status === "UNAVAILABLE" ? `AI unavailable (${purpose.unavailableReason})` : purpose.purpose?.reasons[0], purpose.purpose?.sourceReferences[0] && `“${purpose.purpose.sourceReferences[0]}”`].filter(Boolean).join(" · ")}
              />
            )}
            {contract && (
              <Row
                label="Contract"
                value={contract.verdict ?? "UNCERTAIN"}
                tone={contract.verdict === "MATCH" ? "ok" : contract.verdict === "MISMATCH" ? "bad" : "warn"}
                detail={!contract.contract?.contractProvided ? "no contract supplied" : (contract.contract.findings.find((f) => f.result !== "MATCH") ?? contract.contract.findings[0])?.detail}
              />
            )}
            {risk?.risk?.ai && <Row label="History" value={risk.risk.ai.assessment.replaceAll("_", " ").toLowerCase()} tone={risk.risk.ai.assessment === "INCONSISTENT_WITH_HISTORY" ? "warn" : "ok"} detail={risk.risk.ai.explanation} />}
            {injected.some((o) => o.injection.modelFlagged) && <Row label="Model noticed" value="instructions in a document" tone="bad" detail={injected.flatMap((o) => o.injection.modelEvidence).slice(0, 2).join(" · ")} />}
          </dl>
          <ul className="mt-3 space-y-0.5 font-mono text-meta text-muted">
            {aiUsed.map((o) => {
              const a = analyses.find((x) => x.id === o.analysisId);
              return (
                <li key={o.analysisId}>
                  {o.task} · {o.model} · {o.promptVersion}
                  {o.cached ? " · cached" : ""}
                  {a?.costUsd ? ` · $${a.costUsd}` : ""}
                  {(a?.validation as { repairs?: number } | null)?.repairs ? " · repaired once" : ""}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {noticed.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="pf-label inline-flex items-center gap-1.5 text-ink">
            <ShieldAlert size={13} aria-hidden /> Why PayFlow paused
          </h3>
          <ul className="mt-2 space-y-1">
            {noticed.map((e, i) => (
              <li key={i} className="text-body text-ink">
                {e.detail}
                <span className={`ml-2 text-label font-semibold uppercase tracking-[0.06em] ${e.source === "ai" ? "text-marker-ink" : "text-muted"}`}>{e.source === "ai" ? "from AI evidence" : "calculated"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-meta text-muted">The authority&apos;s own policy turned this evidence into “{decision?.outcome.replaceAll("_", " ").toLowerCase()}”. The AI did not decide.</p>
        </div>
      )}
    </section>
  );
}
