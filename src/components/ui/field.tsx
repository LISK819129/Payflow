import type { InputHTMLAttributes } from "react";

/**
 * Underline field. On focus the rule turns into a marker stroke drawn left to
 * right — the highlighter treatment, used for inputs instead of a glowing box.
 */
export function Field({ label, id, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: string }) {
  return (
    <div className="group">
      <label htmlFor={id} className="pf-label block">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          {...input}
          className="peer block w-full border-0 border-b border-field bg-transparent px-0 pb-2 pt-1 text-lead text-ink outline-none placeholder:text-faint focus-visible:shadow-none focus-visible:outline-none"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 h-[3px] w-full origin-left scale-x-0 bg-marker transition-transform duration-[var(--pf-dur)] ease-pf peer-focus:scale-x-100"
        />
      </div>
      {hint && <p className="mt-1.5 text-meta text-muted">{hint}</p>}
    </div>
  );
}
