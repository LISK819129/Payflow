import { requireUser } from "@/server/auth/current";
import { logoutAction } from "../login/actions";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:w-56 md:border-b-0 md:border-r">
        <div className="px-4 py-4">
          <div className="text-[15px] font-semibold tracking-tight">PayFlow</div>
          <div className="mt-0.5 truncate text-xs text-muted">{user.workspaceName}</div>
        </div>
        <NavLinks />
        <div className="mt-auto hidden border-t border-border px-4 py-3 md:block">
          <div className="truncate text-xs text-muted">{user.email}</div>
          <div className="text-[11px] uppercase tracking-wide text-faint">{user.role}</div>
          <form action={logoutAction}>
            <button className="mt-2 text-xs text-muted underline-offset-2 hover:text-text hover:underline">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
