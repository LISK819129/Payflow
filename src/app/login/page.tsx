import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-lg font-semibold tracking-tight">PayFlow</div>
          <p className="mt-1 text-sm text-muted">Tell PayPal how your money should behave.</p>
        </div>
        <LoginForm />
        <p className="mt-6 text-xs text-faint">Connected to PayPal Sandbox. No real money moves.</p>
      </div>
    </main>
  );
}
