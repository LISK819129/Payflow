"use client";

import { Check } from "lucide-react";

export const STAGES = ["Understand", "Compile", "Validate", "Ready"] as const;
export type Stage = (typeof STAGES)[number] | "idle";

/**
 * Restrained progress for compilation. Stages mirror what actually happens:
 * Understand (instruction checked), Compile (the model is working), Validate
 * (PayFlow's deterministic checks), Ready (result available).
 */
export function CompileStages({ stage, failed }: { stage: Stage; failed?: boolean }) {
  const at = stage === "idle" ? -1 : STAGES.indexOf(stage);
  return (
    <ol className="flex items-center gap-2" aria-label="Compilation progress">
      {STAGES.map((s, i) => {
        const done = i < at || (i === at && s === "Ready");
        const active = i === at && s !== "Ready";
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 text-body-sm transition-colors duration-[var(--pf-dur)] ${
                done ? "text-ink" : active ? "font-medium text-ink" : "text-faint"
              } ${active && failed ? "text-danger" : ""}`}
              aria-current={active ? "step" : undefined}
            >
              {done ? (
                <Check size={13} strokeWidth={2.25} className="text-ok" aria-hidden />
              ) : active ? (
                <span aria-hidden className={`inline-block size-2 rounded-full ${failed ? "bg-danger" : "animate-live-dot bg-marker"}`} />
              ) : (
                <span aria-hidden className="inline-block size-2 rounded-full border border-line-strong" />
              )}
              {s}
            </span>
            {i < STAGES.length - 1 && <span aria-hidden className={`h-px w-6 ${i < at ? "bg-ink" : "bg-line-strong"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
