import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui";
import { getCurrentUser } from "@/server/auth/current";
import { FlowLine } from "./flow-line";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <main className="min-h-screen bg-surface">
      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 px-6 md:px-12 lg:grid-cols-[1fr_1fr] lg:gap-24">
        <div className="flex flex-col justify-between py-10 lg:py-14">
          <span aria-hidden />

          <div className="my-14 max-w-sm">
            <Wordmark size="lg" draw />
            <p className="mt-3 text-lead text-muted">Tell PayPal how your money should behave.</p>
            <div className="mt-12">
              <LoginForm />
            </div>
          </div>

          <p className="flex items-center gap-2 text-meta text-muted">
            <span className="inline-block size-1.5 rounded-full bg-marker" aria-hidden />
            PayPal Sandbox · No real money moves.
          </p>
        </div>

        <div className="hidden items-center border-l border-line pl-16 lg:flex">
          <FlowLine />
        </div>
      </div>
    </main>
  );
}
