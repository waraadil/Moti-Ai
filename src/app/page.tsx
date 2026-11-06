import { redirect } from "next/navigation";
import { getOptionalSession } from "@/server/auth/session";
import { isPublicEnvConfigured } from "@/lib/env";

/**
 * Entry point.
 *
 * Signed in -> contacts. Signed out -> login. If Supabase is not configured we
 * still send users to /login, which renders an explicit setup notice.
 */
export default async function RootPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  redirect(session ? "/contacts" : "/login");
}
