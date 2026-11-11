/**
 * What the user did with previous suggestions.
 *
 * Phase 3 requires the generator to learn from accepted, edited and rejected
 * drafts. The signals were modelled in `lib/intelligence/reply.ts` but nothing
 * ever loaded them, so every run started from zero and could re-offer a reply
 * the user had already thrown away.
 *
 * Kept server-only: draft bodies are private conversation content.
 */

import "server-only";

import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { ReplyFeedback } from "@/lib/intelligence/reply";

/** How many examples of each kind to consider. Enough to show a pattern. */
const LIMIT_PER_KIND = 5;

/** Bodies are trimmed to this length so one long draft cannot dominate. */
const MAX_BODY_CHARS = 400;

function shorten(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed;
}

/**
 * Loads the most recent feedback for one contact.
 *
 * Scoped to a single contact on purpose: how the user talks to a colleague says
 * nothing about how they talk to their sister, so a global preference would
 * make drafts drift towards an average of everyone.
 */
export async function loadReplyFeedback(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<ReplyFeedback> {
  const { data, error } = await supabase
    .from("reply_drafts")
    .select("status, body, edited_body, tone, created_at")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .in("status", ["accepted", "edited", "discarded"])
    .order("created_at", { ascending: false })
    .limit(LIMIT_PER_KIND * 3);

  if (error) throw error;

  const feedback: ReplyFeedback = { accepted: [], edited: [], rejected: [] };

  for (const row of data ?? []) {
    const body = shorten(row.body);

    if (row.status === "accepted" && feedback.accepted.length < LIMIT_PER_KIND) {
      feedback.accepted.push({ body, tone: row.tone });
    } else if (
      row.status === "edited" &&
      row.edited_body &&
      feedback.edited.length < LIMIT_PER_KIND
    ) {
      feedback.edited.push({ original: body, edited: shorten(row.edited_body) });
    } else if (row.status === "discarded" && feedback.rejected.length < LIMIT_PER_KIND) {
      feedback.rejected.push({ body });
    }
  }

  return feedback;
}

/** True when there is nothing to learn from yet, so prompts stay unchanged. */
export function isEmptyFeedback(feedback: ReplyFeedback): boolean {
  return (
    feedback.accepted.length === 0 &&
    feedback.edited.length === 0 &&
    feedback.rejected.length === 0
  );
}
