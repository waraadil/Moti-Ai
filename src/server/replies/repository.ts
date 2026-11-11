/**
 * Reply draft data access.
 *
 * Drafts are suggestions for a human to review. Nothing in this module (or
 * anywhere else in the codebase) can send a message: there is no send path, and
 * the `reply_drafts` table has no outbound status beyond the review lifecycle.
 *
 * Lifecycle, enforced by the schema:
 *   draft ──accept──> accepted   (accepted_at set)
 *   draft ──edit────> edited     (edited_body + accepted_at set)
 *   draft ──discard─> discarded
 */

import "server-only";

import { NotFoundError } from "@/lib/errors";
import type { ReplyDraftRow, ReplyDraftStatus } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type NewReplyDraft = {
  userId: string;
  contactId: string;
  analysisVersionId: string | null;
  inReplyToMessageId: string | null;
  body: string;
  tone: string | null;
  usedMemoryIds: string[];
  modelProvider: string | null;
  modelName: string | null;
  promptVersion: string | null;
};

/** Maximum drafts kept per contact; older discarded ones are pruned. */
const MAX_DRAFTS_PER_CONTACT = 50;

/**
 * Replaces the open drafts for a contact with a freshly generated set.
 *
 * Open (still `draft`) rows are discarded rather than deleted, so the history of
 * what was suggested — and what the user rejected — survives. Accepted and
 * edited drafts are never touched.
 */
export async function replaceOpenDrafts(
  supabase: ServerSupabaseClient,
  drafts: readonly NewReplyDraft[],
): Promise<ReplyDraftRow[]> {
  if (drafts.length === 0) return [];

  const { userId, contactId } = drafts[0]!;

  const { error: discardError } = await supabase
    .from("reply_drafts")
    .update({ status: "discarded" as ReplyDraftStatus })
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("status", "draft");

  if (discardError) throw discardError;

  const { data, error } = await supabase
    .from("reply_drafts")
    .insert(
      drafts.map((draft) => ({
        user_id: draft.userId,
        contact_id: draft.contactId,
        analysis_version_id: draft.analysisVersionId,
        in_reply_to_message_id: draft.inReplyToMessageId,
        status: "draft" as ReplyDraftStatus,
        tone: draft.tone,
        body: draft.body,
        used_memory_ids: draft.usedMemoryIds,
        model_provider: draft.modelProvider,
        model_name: draft.modelName,
        prompt_version: draft.promptVersion,
      })),
    )
    .select("*");

  if (error) throw error;
  return data ?? [];
}

/** Drafts for a contact, newest generation first. */
export async function listDrafts(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  options: { statuses?: ReplyDraftStatus[]; limit?: number } = {},
): Promise<ReplyDraftRow[]> {
  const statuses = options.statuses ?? ["draft", "accepted", "edited"];

  const { data, error } = await supabase
    .from("reply_drafts")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? MAX_DRAFTS_PER_CONTACT);

  if (error) throw error;
  return data ?? [];
}

async function requireDraft(
  supabase: ServerSupabaseClient,
  userId: string,
  draftId: string,
): Promise<ReplyDraftRow> {
  const { data, error } = await supabase
    .from("reply_drafts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", draftId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("That draft does not exist or is not yours.");
  return data;
}

/**
 * Marks a draft accepted as written.
 * Only an un-reviewed draft can be accepted: re-accepting would silently
 * overwrite a decision the user already recorded.
 */
export async function acceptDraft(
  supabase: ServerSupabaseClient,
  userId: string,
  draftId: string,
): Promise<ReplyDraftRow> {
  const draft = await requireDraft(supabase, userId, draftId);

  if (draft.status !== "draft") {
    throw new NotFoundError(
      `That draft has already been ${draft.status}. Generate a fresh set instead.`,
    );
  }

  const { data, error } = await supabase
    .from("reply_drafts")
    .update({ status: "accepted" as ReplyDraftStatus, accepted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", draftId)
    .eq("status", "draft")
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new NotFoundError("That draft could not be updated.");
  return data;
}

/**
 * Records that the user changed a draft before using it.
 * Keeps both the original `body` and the user's `edited_body` so the difference
 * between what Moti suggested and what the human actually wrote stays visible.
 */
export async function editDraft(
  supabase: ServerSupabaseClient,
  userId: string,
  draftId: string,
  editedBody: string,
): Promise<ReplyDraftRow> {
  const trimmed = editedBody.trim();
  if (trimmed.length === 0) {
    throw new NotFoundError("An edited draft cannot be empty. Discard it instead.");
  }
  if (trimmed.length > 4000) {
    throw new NotFoundError("That draft is too long. Keep it under 4000 characters.");
  }

  const draft = await requireDraft(supabase, userId, draftId);
  if (draft.status !== "draft") {
    throw new NotFoundError(`That draft has already been ${draft.status}.`);
  }

  const { data, error } = await supabase
    .from("reply_drafts")
    .update({
      status: "edited" as ReplyDraftStatus,
      edited_body: trimmed,
      accepted_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", draftId)
    .eq("status", "draft")
    .select("*")
    .single();

  if (error) throw error;
  if (!data) throw new NotFoundError("That draft could not be updated.");
  return data;
}

/** Marks a draft discarded. Idempotent: re-discarding is not an error. */
export async function discardDraft(
  supabase: ServerSupabaseClient,
  userId: string,
  draftId: string,
): Promise<void> {
  const draft = await requireDraft(supabase, userId, draftId);

  if (draft.status === "discarded") return;
  if (draft.status !== "draft") {
    throw new NotFoundError(`That draft has already been ${draft.status}.`);
  }

  const { error } = await supabase
    .from("reply_drafts")
    .update({ status: "discarded" as ReplyDraftStatus })
    .eq("user_id", userId)
    .eq("id", draftId)
    .eq("status", "draft");

  if (error) throw error;
}
