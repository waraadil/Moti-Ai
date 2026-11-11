/**
 * Health endpoint.
 *
 * Reports configuration state honestly. A live database check only runs when
 * MOTI_ENABLE_DB_VERIFY=true, so an unauthenticated endpoint cannot be used to
 * hammer the database. No secret values are ever returned: only booleans.
 */

import { NextResponse } from "next/server";
import { isPublicEnvConfigured } from "@/lib/env";
import { tryCreateServerSupabaseClient } from "@/lib/supabase/server";
import { providerSummary } from "@/lib/ai";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = isPublicEnvConfigured();
  const verify = process.env.MOTI_ENABLE_DB_VERIFY === "true";

  let database: "ok" | "unreachable" | "not_configured" | "skipped" = "skipped";

  if (!configured) {
    database = "not_configured";
  } else if (verify) {
    try {
      const supabase = await tryCreateServerSupabaseClient();
      if (supabase) {
        // A cheap, RLS-safe query: anon can select nothing but the request
        // still proves connectivity and that the schema exists.
        const { error } = await supabase.from("contacts").select("id").limit(1);
        database = error ? "unreachable" : "ok";
      } else {
        database = "not_configured";
      }
    } catch {
      database = "unreachable";
    }
  }

  // Reported without a network call: safe, cheap, and enough to tell whether an
  // AI feature will work. `?probe=ai` runs the full connectivity test instead.
  const ai = providerSummary();

  const healthy = configured && database !== "unreachable" && ai.configured;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        supabaseConfigured: configured,
        database,
        analysisProvider: {
          configured: ai.configured,
          provider: ai.provider,
          model: ai.model,
          isGenerative: ai.isGenerative,
          // A boolean only. The key itself is never returned.
          hasApiKey: ai.hasApiKey,
          error: ai.error,
        },
      },
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
