import { LogOut } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { logoutAction } from "../login/actions";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:border-b-0 md:border-r">
        <div className="px-4 pb-6 pt-5">
          <Link href="/" className="rounded-sm">
            <Wordmark size="sm" />
          </Link>
          <div className="mt-1 truncate text-meta text-muted">{user.workspaceName}</div>
        </div>
        <NavLinks />
        <div className="hidden border-t border-line px-4 py-4 md:block">
          <div className="truncate text-body-sm text-ink-2">{user.email}</div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="pf-label">{user.role.toLowerCase()}</span>
            <form action={logoutAction}>
              <button className="inline-flex items-center gap-1 rounded-sm text-meta text-muted hover:text-ink">
                <LogOut size={12} strokeWidth={1.75} aria-hidden />
                Sign out
              </button>
            </form>
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-meta text-faint">
            <span className="inline-block size-1.5 rounded-full bg-marker" aria-hidden />
            PayPal Sandbox
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-5 py-8 md:px-12 md:py-12 xl:px-16">
        <div className="mx-auto max-w-[1180px]">{children}</div>
      </main>
    </div>
  );
}
