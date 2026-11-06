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

  const healthy = configured && database !== "unreachable";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        supabaseConfigured: configured,
        database,
      },
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
