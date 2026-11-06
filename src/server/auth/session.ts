/**
 * Session helpers.
 *
 * Single place that answers "who is making this request?". Every server-side
 * data function takes a `userId` from here rather than trusting a parameter
 * from the client.
 */

import "server-only";

import { UnauthorizedError } from "@/lib/errors";
import { tryCreateServerSupabaseClient, type ServerSupabaseClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/supabase/database.types";

export type SessionContext = {
  userId: string;
  email: string | null;
  profile: ProfileRow | null;
  supabase: ServerSupabaseClient;
};

/**
 * Requires an authenticated user with a configured Supabase project.
 * Throws `UnauthorizedError` so route handlers can return a clean 401.
 */
export async function requireSession(): Promise<SessionContext> {
  const supabase = await tryCreateServerSupabaseClient();

  if (!supabase) {
    throw new UnauthorizedError(
      "Supabase is not configured yet. Add your project URL and anon key to .env.local.",
    );
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new UnauthorizedError();
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: user.email ?? null,
    profile: profile ?? null,
    supabase,
  };
}

/**
 * Non-throwing variant for pages that render a signed-out state.
 * Returns null when there is no session or no configuration.
 */
export async function getOptionalSession(): Promise<SessionContext | null> {
  try {
    return await requireSession();
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}
