/**
 * AI connectivity diagnostic endpoint.
 *
 * Gated on an authenticated session: an open endpoint that performs a paid
 * completion probe would let anyone burn the owner's quota.
 *
 *   GET /api/ai/diagnose          -> reachability only (no tokens spent)
 *   GET /api/ai/diagnose?probe=1  -> also performs a small real completion
 *
 * The response never contains the API key or the full prompt.
 */

import { NextResponse } from "next/server";
import { diagnoseProvider } from "@/lib/ai";
import { tryCreateServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await tryCreateServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase is not configured, so the diagnostic cannot authenticate you." },
      { status: 503 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in to run the diagnostic." }, { status: 401 });
  }

  const url = new URL(request.url);
  const probe = url.searchParams.get("probe") === "1";

  const report = await diagnoseProvider({ skipCompletion: !probe });

  // 200 even when unhealthy: the body describes the failure, and a 5xx here
  // would be indistinguishable from the endpoint itself being broken.
  return NextResponse.json(report);
}
