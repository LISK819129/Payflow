"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4 rounded-lg border border-border bg-surface p-6">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input
          name="email"
          defaultValue={state.email}
          type="email"
          autoComplete="username"
          required
          className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>
      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
