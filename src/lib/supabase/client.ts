/**
 * Browser Supabase client.
 *
 * Uses only the anon key, so every query is constrained by Row Level Security.
 * This module must never import `@/lib/env` server helpers or the admin client.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { getPublicEnv } from "@/lib/env";

export type BrowserSupabaseClient = SupabaseClient<Database>;

let browserClient: BrowserSupabaseClient | null = null;

export function createBrowserSupabaseClient(): BrowserSupabaseClient {
  if (browserClient) return browserClient;

  const env = getPublicEnv();

  browserClient = createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  return browserClient;
}
