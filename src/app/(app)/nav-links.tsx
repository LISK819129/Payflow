"use client";

import {
  Activity,
  ArrowLeftRight,
  BookOpen,
  House,
  KeyRound,
  Landmark,
  Radio,
  ScrollText,
  Settings2,
  Stamp,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; icon: LucideIcon; phase?: number };

// Items with a `phase` have no backend yet: shown, not linked, so the shell is
// complete without pretending those screens exist.
const primary: Item[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/flows", label: "Flows", icon: Workflow },
  { href: "/executions", label: "Executions", icon: Activity },
  { href: "/approvals", label: "Approvals", icon: Stamp },
  { href: "/agents", label: "Agents", icon: KeyRound },
  { href: "/authority", label: "Authority", icon: Landmark },
  { href: "/transactions", label: "PayPal activity", icon: ArrowLeftRight },
  { href: "/events", label: "PayPal events", icon: Radio },
  { href: "/audit", label: "Audit", icon: ScrollText },
];
const secondary: Item[] = [
  { href: "/guide", label: "Demo guide", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

function NavItem({ item, active }: { item: Item; active: boolean }) {
  const Icon = item.icon;
  const inner = (
    <>
      <span
        aria-hidden
        className={`absolute inset-y-1.5 left-0 w-[3px] rounded-r-sm bg-marker transition-transform duration-[var(--pf-dur)] ease-pf ${active ? "scale-y-100" : "scale-y-0"}`}
      />
      <Icon size={16} strokeWidth={1.5} aria-hidden className={active ? "text-ink" : "text-faint group-hover:text-ink-2"} />
      <span>{item.label}</span>
      {item.phase && <span className="ml-auto font-mono text-[10px] text-faint">P{item.phase}</span>}
    </>
  );
  const cls = `group relative flex items-center gap-2.5 whitespace-nowrap py-1.5 pl-4 pr-3 text-body transition-colors duration-[var(--pf-dur-fast)]`;
  if (item.phase) {
    return (
      <span className={`${cls} cursor-default text-faint`} aria-disabled title={`Arrives in Phase ${item.phase}`}>
        {inner}
      </span>
    );
  }
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={`${cls} ${active ? "font-medium text-ink" : "text-muted hover:text-ink"}`}>
      {inner}
    </Link>
  );
}

export function NavLinks() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col">
      <div className="flex gap-0.5 overflow-x-auto md:flex-col">
        {primary.map((i) => (
          <NavItem key={i.href} item={i} active={isActive(i.href)} />
        ))}
      </div>
      <div className="mt-4 hidden border-t border-line pt-4 md:block">
        {secondary.map((i) => (
          <NavItem key={i.href} item={i} active={isActive(i.href)} />
        ))}
      </div>
    </nav>
  );
}
