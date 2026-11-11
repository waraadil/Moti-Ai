"use server";

/**
 * Reply draft actions.
 *
 * Generate, then accept / edit / discard. Every action re-derives the user from
 * the session.
 *
 * There is deliberately no "send" action: Moti AI does not automate WhatsApp and
 * has no outbound path. Accepting a draft records that the human chose to use it;
 * it does not transmit anything.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import { generateReplyDrafts } from "@/server/replies/generate";
import { acceptDraft, discardDraft, editDraft } from "@/server/replies/repository";

export type ReplyActionResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

function revalidateContact(contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
}

export async function generateDraftsAction(formData: FormData): Promise<ReplyActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return { ok: false, message: "Missing contact." };

  try {
    const { supabase, userId, email } = await requireSession();
    const contact = await requireContact(supabase, userId, contactId);

    const result = await generateReplyDrafts({
      userId,
      contactId,
      contactName: contact.display_name,
      selfName: email ? (email.split("@")[0] ?? null) : null,
      supabase,
    });

    revalidateContact(contactId);

    switch (result.status) {
      case "created":
        return {
          ok: true,
          message: `Generated ${result.drafts} draft${result.drafts === 1 ? "" : "s"}.`,
          detail:
            result.rejected > 0
              ? `${result.rejected} suggestion${result.rejected === 1 ? " was" : "s were"} rejected by the safety checks.`
              : "Review before using — nothing is sent automatically.",
        };
      case "no_analysis":
        return {
          ok: false,
          message: "Analyse this conversation first.",
          detail: "Drafts use the communication profiles and memories from an analysis run.",
        };
      case "no_incoming":
        return {
          ok: false,
          message: "Nothing to reply to.",
          detail: result.problem ?? undefined,
        };
      case "empty":
        return {
          ok: false,
          message: "No draft passed the safety checks.",
          detail: result.problem ?? "Nothing was saved rather than offer a risky suggestion.",
        };
      case "failed":
      default:
        return {
          ok: false,
          message: "Could not generate drafts.",
          detail: result.problem ?? undefined,
        };
    }
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] draft generation failed", error);
    return { ok: false, message: "Could not generate drafts. Please try again." };
  }
}

async function runOnDraft(
  formData: FormData,
  operation: (
    supabase: Awaited<ReturnType<typeof requireSession>>["supabase"],
    userId: string,
    draftId: string,
  ) => Promise<void>,
  success: string,
): Promise<ReplyActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const draftId = String(formData.get("draftId") ?? "");
  if (!contactId || !draftId) return { ok: false, message: "Missing draft." };

  try {
    const { supabase, userId } = await requireSession();
    await operation(supabase, userId, draftId);
    revalidateContact(contactId);
    return { ok: true, message: success };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] draft action failed", error);
    return { ok: false, message: "Could not update that draft. Please try again." };
  }
}

export async function acceptDraftAction(formData: FormData): Promise<ReplyActionResult> {
  return runOnDraft(
    formData,
    async (supabase, userId, draftId) => {
      await acceptDraft(supabase, userId, draftId);
    },
    "Marked as used. Copy it into WhatsApp yourself — Moti never sends messages.",
  );
}

export async function editDraftAction(formData: FormData): Promise<ReplyActionResult> {
  const editedBody = String(formData.get("editedBody") ?? "").trim();
  if (editedBody.length === 0) {
    return { ok: false, message: "Write your version before saving, or discard the draft." };
  }

  return runOnDraft(
    formData,
    async (supabase, userId, draftId) => {
      await editDraft(supabase, userId, draftId, editedBody);
    },
    "Saved your edited version. Both versions are kept.",
  );
}

export async function discardDraftAction(formData: FormData): Promise<ReplyActionResult> {
  return runOnDraft(
    formData,
    async (supabase, userId, draftId) => {
      await discardDraft(supabase, userId, draftId);
    },
    "Draft discarded.",
  );
}
