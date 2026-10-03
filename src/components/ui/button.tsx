import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium select-none " +
  "transition-[background-color,border-color,color,transform] duration-[var(--pf-dur-fast)] ease-pf " +
  "active:translate-y-px disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  // The marker: the one place a button carries the brand colour.
  primary: "bg-marker text-on-marker hover:bg-[color-mix(in_oklab,var(--pf-marker)_88%,black)]",
  secondary: "border border-line-strong bg-surface text-ink hover:border-ink",
  quiet: "text-muted hover:text-ink hover:bg-sunken",
  danger: "border border-line-strong bg-surface text-danger hover:border-danger",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-body-sm",
  md: "h-9 px-3.5 text-body",
  lg: "h-11 px-5 text-lead",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra = "") {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; children: ReactNode }) {
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
