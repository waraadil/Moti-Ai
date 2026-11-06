/**
 * Supabase email-confirmation / magic-link callback.
 *
 * Exchanges the one-time code in the URL for a session cookie, then forwards
 * the user on. Errors go back to /login with a message rather than a stack.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isPublicEnvConfigured } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  const next =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/contacts";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  if (!isPublicEnvConfigured()) {
    return NextResponse.redirect(`${origin}/login?error=not_configured`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[moti] auth callback failed", error.message);
    return NextResponse.redirect(`${origin}/login?error=link_expired`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
