import { LogOut } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "@/components/ui";
import { requireUser } from "@/server/auth/current";
import { environmentLabel } from "@/server/demo/queries";
import { logoutAction } from "../login/actions";
import { MainFrame } from "./main-frame";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const environment = environmentLabel();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:border-b-0 md:border-r">
        <div className="px-4 pb-6 pt-5">
          <Link href="/" className="rounded-sm">
            <Wordmark size="sm" />
          </Link>
          <div className="mt-1 truncate text-meta text-muted">{user.workspaceName}</div>
          <div
            className={`mt-3 inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] ${environment.sandbox ? "border-line-strong text-ink-2" : "border-danger text-danger"}`}
            title={environment.sandbox ? "Every PayPal call goes to PayPal's Sandbox — test money only" : "LIVE PayPal"}
          >
            <span className={`inline-block size-1.5 rounded-full ${environment.sandbox ? "bg-marker" : "bg-danger"}`} aria-hidden />
            {environment.label}
          </div>
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
          <p className="mt-3 text-meta text-faint">Sandbox only — no real money moves.</p>
        </div>
      </aside>
      <MainFrame>{children}</MainFrame>
    </div>
  );
}
