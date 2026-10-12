"use client";

import { ArrowRight, CircleAlert, CircleCheck, CircleX, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { compileAction, type CompileActionResult } from "@/app/(app)/flows/ai-actions";
import { Button, buttonClass, ProvenanceTag, SetupRequired } from "@/components/ui";
import type { WorkflowGraph } from "@/server/workflow/dsl/nodes";
import { CompileStages, type Stage } from "./compile-stages";
import { RevealGraph } from "./reveal-graph";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "What should your money do?" — a command surface, not a chat. One
 * instruction in, one validated draft (or precise questions) out.
 */
export function CompilePanel({
  aiConfigured,
  stored,
  initialInstruction,
}: {
  aiConfigured: boolean;
  /** Pre-filled from a "Try PayFlow" example. Nothing is compiled until the person presses the button. */
  initialInstruction?: string;
  /** A past compilation re-rendered from its record (no model call). */
  stored?: { instruction: string; result: CompileActionResult; model: string; at: string };
}) {
  const [instruction, setInstruction] = useState(stored?.instruction ?? initialInstruction ?? "");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [stage, setStage] = useState<Stage>(stored ? "Ready" : "idle");
  const [result, setResult] = useState<CompileActionResult | null>(stored?.result ?? null);
  const [pending, start] = useTransition();

  const run = (text: string) =>
    start(async () => {
      setResult(null);
      setStage("Understand");
      if (text.trim().length < 8) {
        setResult({ status: "FAILED", error: "Describe what the workflow should do in a sentence or more.", attempts: 0 });
        return;
      }
      await sleep(180);
      setStage("Compile");
      const r = await compileAction(text);
      setStage("Validate");
      await sleep(380);
      setResult(r);
      setStage(r.status === "COMPILED" || r.status === "NEEDS_CLARIFICATION" || r.status === "UNSUPPORTED" ? "Ready" : "Validate");
    });

  const questions = result?.status === "NEEDS_CLARIFICATION" ? result.questions : [];
  const withAnswers = () =>
    `${instruction.trim()}\n\nAnswers to your questions:\n${questions
      .map((q, i) => (answers[i]?.trim() ? `- ${q.question} → ${answers[i].trim()}` : null))
      .filter(Boolean)
      .join("\n")}`;

  return (
    <section aria-labelledby="compile-h" className="mb-14">
      <h2 id="compile-h" className="text-title font-semibold tracking-[-0.01em]">
        What should your money do?
      </h2>
      <form
        className="group mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending && aiConfigured) run(instruction);
        }}
      >
        <div className="relative">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!pending && aiConfigured) run(instruction);
              }
            }}
            rows={3}
            disabled={!aiConfigured}
            placeholder="When Nova Labs pays an invoice, check the currency is USD and ask me if it differs from the invoice by more than 10%."
            aria-label="Describe a financial workflow"
            className="peer block w-full resize-y border-0 border-b border-field bg-transparent pb-3 text-lead leading-7 text-ink outline-none placeholder:text-faint focus-visible:shadow-none disabled:cursor-not-allowed"
          />
          <span aria-hidden className="pointer-events-none absolute bottom-0 left-0 h-[3px] w-full origin-left scale-x-0 bg-marker transition-transform duration-[var(--pf-dur)] ease-pf peer-focus:scale-x-100" />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          {aiConfigured ? <CompileStages stage={stage} failed={!!result && ["INVALID", "FAILED"].includes(result.status)} /> : <SetupRequired>AI provider not configured</SetupRequired>}
          <div className="flex items-center gap-3">
            <span className="hidden text-meta text-faint sm:inline">Ctrl + Enter</span>
            <Button type="submit" variant="primary" disabled={pending || !aiConfigured || instruction.trim().length === 0}>
              <Sparkles size={15} aria-hidden /> {pending ? "Compiling…" : "Generate"}
            </Button>
          </div>
        </div>
      </form>

      {stored && result === stored.result && (
        <p className="mt-4 font-mono text-meta text-muted">
          Stored result · {stored.model} · {new Date(stored.at).toLocaleString("en-GB", { hour12: false })} · {stored.result.status === "FAILED" ? "" : `${(stored.result as { attempts: number }).attempts} attempt(s)`}
        </p>
      )}
      {result && <Result result={result} />}

      {questions.length > 0 && (
        <div className="mt-6 max-w-3xl space-y-4" role="group" aria-label="Answer the questions">
          {questions.map((q, i) => (
            <label key={i} className="block">
              <span className="text-body text-ink">{q.question}</span>
              <input
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                className="mt-1 block w-full border-0 border-b border-field bg-transparent pb-1.5 text-body outline-none focus:border-ink focus-visible:shadow-none"
              />
            </label>
          ))}
          <Button
            variant="secondary"
            disabled={pending || Object.values(answers).every((a) => !a?.trim())}
            onClick={() => {
              const next = withAnswers();
              setInstruction(next);
              setAnswers({});
              run(next);
            }}
          >
            Compile again with these answers
          </Button>
        </div>
      )}
    </section>
  );
}

function Result({ result }: { result: CompileActionResult }) {
  if (result.status === "SETUP_REQUIRED" || result.status === "FORBIDDEN") {
    return <p className="mt-6 text-body text-warn">{result.error}</p>;
  }
  if (result.status === "FAILED") {
    return (
      <p className="mt-6 flex items-start gap-2 text-body text-danger" role="alert">
        <CircleX size={16} className="mt-0.5 shrink-0" aria-hidden /> {result.error} Nothing was saved.
      </p>
    );
  }

  const ai = "ai" in result ? result.ai : undefined;
  const graph = "graph" in result ? (result.graph as WorkflowGraph | undefined) : undefined;

  return (
    <div className="mt-8 grid gap-x-12 gap-y-8 animate-fade-up xl:grid-cols-[1.4fr_1fr]">
      {graph && graph.nodes.length > 0 ? (
        <div className="h-[460px] rounded border border-line bg-canvas">
          <RevealGraph graph={graph} />
        </div>
      ) : (
        <div className="hidden xl:block" />
      )}

      <div className="space-y-8">
        {ai && (
          <section aria-label="AI interpretation">
            <div className="flex items-center gap-2 border-b border-line pb-2">
              <h3 className="pf-label">AI interpretation</h3>
              <ProvenanceTag value="AI_GENERATED" />
            </div>
            <p className="mt-3 text-body text-ink-2">{ai.interpretation}</p>
            {ai.assumptions.length > 0 && (
              <>
                <h4 className="pf-label mt-4">Assumptions</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-body-sm text-muted">
                  {ai.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}
            {ai.unsupported.length > 0 && (
              <>
                <h4 className="pf-label mt-4">Not expressed</h4>
                <ul className="mt-1 space-y-1 text-body-sm text-muted">
                  {ai.unsupported.map((u, i) => (
                    <li key={i}>
                      <span className="text-ink-2">{u.request}</span> — {u.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        <section aria-label="PayFlow validation">
          <div className="flex items-center gap-2 border-b border-line pb-2">
            <h3 className="pf-label">PayFlow validation</h3>
            <span className="text-meta text-muted">deterministic · decides</span>
          </div>
          <Verdict result={result} />
        </section>
      </div>
    </div>
  );
}

function Line({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CircleCheck : tone === "warn" ? CircleAlert : CircleX;
  return (
    <li className={`flex items-start gap-2 text-body-sm ${tone === "ok" ? "text-ink-2" : tone === "warn" ? "text-warn" : "text-danger"}`}>
      <Icon size={14} className={`mt-0.5 shrink-0 ${tone === "ok" ? "text-ok" : ""}`} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function Verdict({ result }: { result: Exclude<CompileActionResult, { status: "SETUP_REQUIRED" | "FORBIDDEN" | "FAILED" }> }) {
  switch (result.status) {
    case "COMPILED":
      return (
        <div>
          <ul className="mt-3 space-y-1.5">
            <Line tone="ok">Graph is structurally valid ({result.graph.nodes.length} nodes)</Line>
            <Line tone="ok">Every money path passes a policy or approval gate</Line>
            <Line tone="ok">Every amount, threshold, counterparty and delay appears in your instruction</Line>
            {result.activationIssues.length === 0 ? (
              <Line tone="ok">Every node can run today — ready for you to review and activate</Line>
            ) : (
              result.activationIssues.map((i, k) => (
                <Line key={k} tone="warn">
                  {i.message}
                </Line>
              ))
            )}
            {result.corrections.map((c, i) => (
              <Line key={`c${i}`} tone="warn">
                PayFlow corrected a boundary: {c}
              </Line>
            ))}
            {result.attempts > 1 && <Line tone="warn">The first answer failed validation; this is the one permitted repair</Line>}
          </ul>
          <div className="mt-5 border-t border-line pt-4">
            <div className="text-body font-semibold text-ink">Your payment rule is ready — as a draft. Nothing runs yet.</div>
            <ol className="mt-2 space-y-1 text-body-sm text-ink-2">
              <li>
                <span className="font-mono text-meta text-faint">1</span> <span className="text-ink">Test it</span> — see what PayFlow would decide for a few payments. PayPal is not contacted.
              </li>
              <li>
                <span className="font-mono text-meta text-faint">2</span> <span className="text-ink">Activate it</span> — only a person can.
              </li>
              <li>
                <span className="font-mono text-meta text-faint">3</span> <span className="text-ink">Let requests in</span> — the rule page shows where they come from (a person, an AI agent or PayPal), and whether an authority lets it pay without asking you.
              </li>
            </ol>
            <Link href={`/flows/${result.workflowId}?test=1`} className={`mt-4 ${buttonClass("primary")}`}>
              Test the rule <ArrowRight size={14} aria-hidden />
            </Link>
            <Link href={`/flows/${result.workflowId}`} className="ml-3 inline-flex items-center gap-1.5 text-body-sm font-medium text-ink hover:underline">
              Open the rule <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
        </div>
      );
    case "NEEDS_CLARIFICATION":
      return (
        <ul className="mt-3 space-y-1.5">
          {result.ungrounded.length > 0 ? (
            <Line tone="warn">The AI proposed {result.ungrounded.length} value(s) your instruction doesn&apos;t state. PayFlow won&apos;t save invented amounts, counterparties or delays — answer below.</Line>
          ) : (
            <Line tone="warn">More detail is needed before a workflow can be built — answer below.</Line>
          )}
          <Line tone="ok">Nothing was saved</Line>
        </ul>
      );
    case "UNSUPPORTED":
      return (
        <ul className="mt-3 space-y-1.5">
          <Line tone="danger">This can&apos;t be expressed as a PayFlow workflow (see above). Nothing was saved.</Line>
        </ul>
      );
    case "INVALID":
      return (
        <div>
          <p className="mt-3 text-body-sm text-danger">The AI&apos;s workflow failed PayFlow&apos;s checks after one repair attempt. Nothing was saved.</p>
          <ul className="mt-2 space-y-1">
            {result.problems.slice(0, 8).map((p, i) => (
              <Line key={i} tone="danger">
                {p}
              </Line>
            ))}
          </ul>
        </div>
      );
  }
}
