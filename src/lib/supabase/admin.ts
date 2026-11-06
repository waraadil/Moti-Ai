/**
 * Privileged Supabase client using the service-role key.
 *
 * SERVER ONLY. This key bypasses Row Level Security, so:
 *   - it is never imported by Client Components,
 *   - `getServerEnv()` throws if this module is evaluated in the browser,
 *   - every caller MUST scope its query with `user_id` explicitly.
 *
 * Use it only for jobs that legitimately span a user's data: background import
 * processing, storage cleanup, admin tooling. Normal request handling should use
 * the cookie-bound client from `./server`.
 */

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { getPublicEnv } from "@/lib/env";
import { getServerEnv } from "@/lib/env/server";

export type AdminSupabaseClient = SupabaseClient<Database>;

export class ServiceRoleNotConfiguredError extends Error {
  constructor() {
    super(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Background processing that needs to bypass " +
        "Row Level Security is unavailable until it is configured in .env.local.",
    );
    this.name = "ServiceRoleNotConfiguredError";
  }
}

let adminClient: AdminSupabaseClient | null = null;

export function isServiceRoleConfigured(): boolean {
  if (typeof window !== "undefined") return false;
  return Boolean(getServerEnv().SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Creates (or reuses) the service-role client.
 * Never expose the returned client or its headers to the browser.
 */
export function createAdminSupabaseClient(): AdminSupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminSupabaseClient() must never run in the browser.");
  }

  if (adminClient) return adminClient;

  const env = getPublicEnv();
  const serviceRoleKey = getServerEnv().SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) throw new ServiceRoleNotConfiguredError();

  adminClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return adminClient;
}

/** Test-only helper so unit tests do not reuse a stale client. */
export function __resetAdminClientForTests(): void {
  adminClient = null;
}
