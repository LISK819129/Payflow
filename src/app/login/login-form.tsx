"use client";

import { ArrowRight } from "lucide-react";
import { useActionState } from "react";
import { Button, Field } from "@/components/ui";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-8">
      <Field id="email" name="email" label="Email" type="email" autoComplete="username" required defaultValue={state.email} />
      <Field id="password" name="password" label="Password" type="password" autoComplete="current-password" required />
      {state.error && (
        <p role="alert" className="border-l-2 border-danger pl-3 text-body text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
        {!pending && <ArrowRight size={16} strokeWidth={2} aria-hidden />}
      </Button>
    </form>
  );
}
