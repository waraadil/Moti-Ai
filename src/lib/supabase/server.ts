/**
 * Server Supabase client (Server Components, Route Handlers, Server Actions).
 *
 * Reads and writes cookies through Next's `cookies()` store so the session is
 * shared with the browser client. Still uses the anon key: all access is
 * governed by Row Level Security as the signed-in user.
 */

import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { getPublicEnv, isPublicEnvConfigured } from "@/lib/env";

export type ServerSupabaseClient = SupabaseClient<Database>;

/**
 * Returns a request-scoped Supabase client.
 *
 * Throws `EnvValidationError` when Supabase is not configured. Callers that
 * need to render a "setup required" state should check
 * `isPublicEnvConfigured()` first instead of catching.
 */
export async function createServerSupabaseClient(): Promise<ServerSupabaseClient> {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies. Session refresh is handled
            // by middleware, so this is safe to ignore here.
          }
        },
      },
    },
  );
}

/**
 * Returns a client, or `null` when Supabase credentials are absent.
 * Used by pages that must render without a database (fresh clone, CI builds).
 */
export async function tryCreateServerSupabaseClient(): Promise<ServerSupabaseClient | null> {
  if (!isPublicEnvConfigured()) return null;
  return createServerSupabaseClient();
}
