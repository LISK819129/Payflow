"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Only sections whose backend exists are listed; more are added as each phase lands.
const links = [
  { href: "/", label: "Dashboard" },
  { href: "/events", label: "PayPal events" },
  { href: "/audit", label: "Audit" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
      {links.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${
              active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
