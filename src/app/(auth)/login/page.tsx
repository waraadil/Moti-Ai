import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/layout/app-shell";
import { ConfigNotice } from "@/components/layout/config-notice";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const session = await getOptionalSession();
  if (session) redirect("/contacts");

  const { next, error } = await searchParams;

  return (
    <AuthShell>
      <div className="border-border-subtle bg-surface-raised rounded-xl border p-6">
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="text-ink-soft mt-1 mb-5 text-sm">
          Your conversations stay private to your account.
        </p>

        {error ? (
          <p
            role="alert"
            className="text-danger mb-4 rounded-lg border border-[oklch(0.87_0.06_25)] bg-[oklch(0.96_0.03_25)] px-3 py-2 text-sm"
          >
            {error === "link_expired"
              ? "That confirmation link has expired. Sign in or request a new one."
              : error === "not_configured"
                ? "Supabase is not configured yet."
                : "That sign-in link was incomplete. Try again."}
          </p>
        ) : null}

        <AuthForm mode="signin" next={next} />
      </div>

      {!isPublicEnvConfigured() ? (
        <div className="mt-4">
          <ConfigNotice />
        </div>
      ) : null}
    </AuthShell>
  );
}
