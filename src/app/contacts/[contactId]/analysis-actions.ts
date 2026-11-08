"use server";

/**
 * Analysis server actions.
 *
 * Runs are synchronous from the user's point of view: the action loads the
 * stored conversation, runs the pipeline and revalidates the contact page.
 *
 * Deliberately absent: any way to send a draft. Reply suggestions are stored as
 * `draft` rows and rendered for human review only.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import { createProvider, loadConversation, runAnalysis } from "@/server/analysis/view";

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
    const messages = await loadConversation(supabase, userId, contactId);

    if (messages.length === 0) {
      return {
        ok: false,
        message: "There is nothing to analyse yet.",
        detail: "Import a WhatsApp export for this contact first.",
      };
    }

    const outcome = await runAnalysis({
      userId,
      contactId,
      contactName: contact.display_name,
      selfName: email ? (email.split("@")[0] ?? null) : null,
      messages,
      supabase,
      provider: createProvider(),
    });

    revalidatePath(`/contacts/${contactId}`);

    switch (outcome.status) {
      case "completed":
        return {
          ok: true,
          message: `Analysed ${outcome.messagesAnalysed.toLocaleString("en-GB")} messages (version ${outcome.version}).`,
          detail: [
            `${outcome.memoriesInserted} new mem${outcome.memoriesInserted === 1 ? "ory" : "ories"}`,
            outcome.memoriesDuplicated > 0 ? `${outcome.memoriesDuplicated} already known` : null,
            outcome.styleReliable ? null : "style evidence is thin — treat profiles as indicative",
            outcome.temporal && outcome.temporal.changes.length > 0
              ? `${outcome.temporal.changes.length} change${outcome.temporal.changes.length === 1 ? "" : "s"} since last run`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        };
      case "cached":
        return {
          ok: true,
          message: "Nothing has changed since the last analysis.",
          detail: "The existing version is still current, so no new version was created.",
        };
      case "skipped_untrusted":
        return {
          ok: false,
          message: "Moti AI refused to analyse this conversation.",
          detail:
            outcome.problem ??
            "The speaker attribution could not be confirmed, and guessing is not allowed.",
        };
      case "skipped_insufficient":
        return {
          ok: false,
          message: "Not enough messages to analyse yet.",
          detail: outcome.coverageNote ?? "Import more history and try again.",
        };
      case "failed":
      default:
        return {
          ok: false,
          message: "Analysis failed.",
          detail: outcome.problem ?? "Please try again.",
        };
    }
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] analysis run failed", error);
    return { ok: false, message: "Could not analyse this contact. Please try again." };
  }
}
