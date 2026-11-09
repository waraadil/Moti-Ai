"use server";

/**
 * Analysis server action.
 *
 * The logic lives in `@/server/analysis/run` so the import flow can trigger an
 * identical run without going through the action boundary.
 *
 * Deliberately absent: any way to send a draft. Reply suggestions are stored as
 * `draft` rows and rendered for human review only.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import { analyseContact } from "@/server/analysis/run";

export type AnalyseResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

export async function runAnalysisAction(formData: FormData): Promise<AnalyseResult> {
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.length === 0) {
    return { ok: false, message: "Missing contact." };
  }

  try {
    const { supabase, userId, email } = await requireSession();
    const contact = await requireContact(supabase, userId, contactId);

    const result = await analyseContact({
      supabase,
      userId,
      contactId,
      contactName: contact.display_name,
      selfName: email ? (email.split("@")[0] ?? null) : null,
    });

    revalidatePath(`/contacts/${contactId}`);

    return { ok: result.ok, message: result.message, detail: result.detail ?? undefined };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] analysis run failed", error);
    return { ok: false, message: "Could not analyse this contact. Please try again." };
  }
}
