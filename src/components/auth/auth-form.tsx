"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInAction, signUpAction, type AuthActionResult } from "@/app/(auth)/actions";

/**
 * Shared sign-in / sign-up form.
 *
 * Progressive enhancement: it works as a plain form post (server action) and
 * shows inline errors when JS is active.
 */

type Mode = "signin" | "signup";

const INITIAL: AuthActionResult = { ok: true };

export function AuthForm({ mode, next }: { mode: Mode; next?: string }) {
  const action = mode === "signin" ? signInAction : signUpAction;
  const [state, formAction, isPending] = useActionState(
    async (_previous: AuthActionResult, formData: FormData) => action(formData),
    INITIAL,
  );

  const error = state.ok ? null : state;
  const fieldErrors = error?.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {error ? (
        <p
          role="alert"
          className="text-danger rounded-lg border border-[oklch(0.87_0.06_25)] bg-[oklch(0.96_0.03_25)] px-3 py-2 text-sm"
        >
          {error.message}
        </p>
      ) : null}

      {mode === "signup" ? (
        <Field
          label="Your name"
          name="displayName"
          type="text"
          autoComplete="name"
          required
          error={fieldErrors.displayName}
        />
      ) : null}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
      />

      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        required
        hint={mode === "signup" ? "At least 10 characters." : undefined}
        error={fieldErrors.password}
      />

      <button
        type="submit"
        disabled={isPending}
        className="bg-accent w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {isPending
          ? mode === "signin"
            ? "Signing in…"
            : "Creating account…"
          : mode === "signin"
            ? "Sign in"
            : "Create account"}
      </button>

      <p className="text-ink-soft pt-1 text-center text-sm">
        {mode === "signin" ? (
          <>
            No account yet?{" "}
            <Link
              href="/signup"
              className="text-accent-ink font-medium underline-offset-2 hover:underline"
            >
              Create one
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link
              href="/login"
              className="text-accent-ink font-medium underline-offset-2 hover:underline"
            >
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  required,
  hint,
  error,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  error?: string;
}) {
  const describedBy = [hint ? `${name}-hint` : null, error ? `${name}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <label htmlFor={name} className="text-ink block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className="border-border-strong bg-surface-raised text-ink placeholder:text-ink-faint focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
      />
      {hint ? (
        <p id={`${name}-hint`} className="text-ink-faint mt-1 text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${name}-error`} className="text-danger mt-1 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
