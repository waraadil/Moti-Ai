import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/layout/app-shell";
import { ConfigNotice } from "@/components/layout/config-notice";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";

export const metadata: Metadata = { title: "Create account" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const session = await getOptionalSession();
  if (session) redirect("/contacts");

  return (
    <AuthShell>
      <div className="border-border-subtle bg-surface-raised rounded-xl border p-6">
        <h1 className="text-lg font-semibold tracking-tight">Create your account</h1>
        <p className="text-ink-soft mt-1 mb-5 text-sm">
          Moti AI works from WhatsApp exports you choose to share. No messaging access is requested.
        </p>
        <AuthForm mode="signup" />
      </div>

      {!isPublicEnvConfigured() ? (
        <div className="mt-4">
          <ConfigNotice />
        </div>
      ) : null}
    </AuthShell>
  );
}
