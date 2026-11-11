/**
 * Shared analysis runner.
 *
 * Used by two callers that must behave identically:
 *   - the "Analyse conversation" button on the contact page,
 *   - the import flow, which re-analyses automatically when a new export lands.
 *
 * Kept out of the server-action module so it can be called from another server
 * module without going through the action boundary.
 */

import "server-only";

import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { createProvider } from "@/lib/ai";
import { runAnalysis, type AnalysisOutcome } from "./pipeline";
import { loadConversation } from "./view";

export type AnalyseContactResult = {
  ok: boolean;
  outcome: AnalysisOutcome | null;
  message: string;
  detail: string | null;
};

/**
 * Runs analysis for one contact and turns the outcome into a message a person
 * can act on. Never throws for an expected failure: the caller shows the text.
 */
export async function analyseContact(params: {
  supabase: ServerSupabaseClient;
  userId: string;
  contactId: string;
  contactName: string;
  selfName: string | null;
}): Promise<AnalyseContactResult> {
  const messages = await loadConversation(params.supabase, params.userId, params.contactId);

  if (messages.length === 0) {
    return {
      ok: false,
      outcome: null,
      message: "There is nothing to analyse yet.",
      detail: "Import a WhatsApp export for this contact first.",
    };
  }

  const outcome = await runAnalysis({
    userId: params.userId,
    contactId: params.contactId,
    contactName: params.contactName,
    selfName: params.selfName,
    messages,
    supabase: params.supabase,
    provider: createProvider(),
  });

  switch (outcome.status) {
    case "completed":
      return {
        ok: true,
        outcome,
        message: `Analysed ${outcome.messagesAnalysed.toLocaleString("en-GB")} messages (version ${outcome.version}).`,
        detail: describeOutcome(outcome),
      };
    case "cached":
      return {
        ok: true,
        outcome,
        message: "Nothing has changed since the last analysis.",
        detail: "The existing version is still current, so no new version was created.",
      };
    case "skipped_untrusted":
      return {
        ok: false,
        outcome,
        message: "Moti AI refused to analyse this conversation.",
        detail:
          outcome.problem ??
          "The speaker attribution could not be confirmed, and guessing is not allowed.",
      };
    case "skipped_insufficient":
      return {
        ok: false,
        outcome,
        message: "Not enough messages to analyse yet.",
        detail: outcome.coverageNote ?? "Import more history and try again.",
      };
    case "failed":
    default:
      return {
        ok: false,
        outcome,
        message: "Analysis failed.",
        detail: outcome.problem ?? "Please try again.",
      };
  }
}

/** Compact summary of what a completed run produced. */
export function describeOutcome(outcome: AnalysisOutcome): string {
  return [
    `${outcome.memoriesInserted} new mem${outcome.memoriesInserted === 1 ? "ory" : "ories"}`,
    outcome.memoriesDuplicated > 0 ? `${outcome.memoriesDuplicated} already known` : null,
    outcome.styleReliable ? null : "style evidence is thin — treat profiles as indicative",
    outcome.temporal && outcome.temporal.changes.length > 0
      ? `${outcome.temporal.changes.length} change${outcome.temporal.changes.length === 1 ? "" : "s"} since last run`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
