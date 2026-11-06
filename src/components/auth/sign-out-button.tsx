"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

/**
 * Signs out and returns to /login.
 *
 * Uses the browser client so the auth cookies are cleared on the client and the
 * middleware refresh doesn't resurrect the session.
 */
export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function handleSignOut() {
    try {
      const supabase = createBrowserSupabaseClient();
      await supabase.auth.signOut();
    } catch {
      // If Supabase is unreachable, still send the user to /login.
    }
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isPending}
      className={
        compact
          ? "text-ink-soft hover:bg-surface-sunken hover:text-ink rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-60"
          : "text-ink-soft hover:bg-surface-raised hover:text-ink w-full rounded-lg px-3 py-2 text-left text-sm font-medium disabled:opacity-60"
      }
    >
      {isPending ? "Signing out…" : "Sign out"}
    </button>
  );
}
