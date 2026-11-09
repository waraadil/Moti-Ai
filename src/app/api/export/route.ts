/**
 * User data export endpoint.
 *
 *   GET /api/export  -> downloads every row Moti AI stores for the caller
 *
 * Authenticated only. The response is a file attachment, so the browser saves it
 * rather than trying to render it. Nothing here can reach another user's data:
 * the user id comes from the session and is applied as a filter on every query.
 */

import { NextResponse } from "next/server";
import { tryCreateServerSupabaseClient } from "@/lib/supabase/server";
import { buildUserExport, exportFilename } from "@/server/data/export";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await tryCreateServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase is not configured, so there is nothing to export." },
      { status: 503 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in to export your data." }, { status: 401 });
  }

  try {
    const payload = await buildUserExport(supabase, user.id);

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFilename()}"`,
        // A download of personal data must never be cached by a shared proxy.
        "cache-control": "no-store, no-cache, must-revalidate, private",
      },
    });
  } catch (error) {
    console.error("[moti] export failed", error);
    return NextResponse.json(
      { error: "The export could not be built. Please try again." },
      { status: 500 },
    );
  }
}
