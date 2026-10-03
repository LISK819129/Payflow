/**
 * The PayFlow wordmark: "Pay" in ink, "Flow" in ink over an imperfect
 * fluorescent marker stroke. Purely typographic; no symbol.
 */
export function Wordmark({ size = "md", draw = false }: { size?: "sm" | "md" | "lg"; draw?: boolean }) {
  const cls = size === "lg" ? "text-[40px] leading-[44px]" : size === "sm" ? "text-[17px] leading-6" : "text-[22px] leading-7";
  return (
    <span className={`${cls} inline-block font-semibold tracking-[-0.025em] text-ink`} aria-label="PayFlow">
      <span aria-hidden>Pay</span>
      <span aria-hidden className={`pf-mark ${draw ? "pf-mark-draw" : ""}`}>
        Flow
      </span>
    </span>
  );
}
