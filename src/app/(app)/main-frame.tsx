"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Full-bleed for the Flow Builder canvas; a padded reading column everywhere else. */
export function MainFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const fullBleed = /^\/flows\/[^/]+$/.test(pathname);
  if (fullBleed) return <main className="min-w-0 flex-1">{children}</main>;
  return (
    <main className="min-w-0 flex-1 px-5 py-8 md:px-12 md:py-12 xl:px-16">
      <div className="mx-auto max-w-[1180px]">{children}</div>
    </main>
  );
}
