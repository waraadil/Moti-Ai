"use server";

/**
 * Away Mode server actions.
 *
 * Every action re-derives the user from the session; none accepts a user id.
 *
 * There is deliberately no "send" action, and none can be added without an
 * official messaging integration. Approving a prepared reply records that the
 * user accepted the text for their own use — it transmits nothing.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { awaySettingsSchema } from "@/lib/validation/schemas";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import {
  clearContactPermission,
  decidePreparedReply,
  getPreparedReply,
  recordAwayEvent,
  setContactPermission,
} from "@/server/away/repository";
import { saveAwaySettings } from "@/server/away/service";

export type AwayActionResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

function revalidateAway() {
  revalidatePath("/away");
}

/** Turns a parse failure or thrown error into a message a person can act on. */
function failure(error: unknown, fallback: string): AwayActionResult {
  if (isAppError(error)) return { ok: false, message: error.userMessage };
  if (error instanceof Error && error.message) {
    return { ok: false, message: error.message };
  }
  return { ok: false, message: fallback };
}

export async function saveAwaySettingsAction(formData: FormData): Promise<AwayActionResult> {
  const parsed = awaySettingsSchema.safeParse({
    status: formData.get("status"),
    startsAt: formData.get("startsAt") || null,
    endsAt: formData.get("endsAt") || null,
    awayMessage: formData.get("awayMessage") || null,
    defaultPermission: formData.get("defaultPermission"),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    const { supabase, userId } = await requireSession();

    const result = await saveAwaySettings(supabase, userId, parsed.data);

    if (!result.ok) return { ok: false, message: result.problem };

    revalidateAway();
    return {
      ok: true,
      message: "Away Mode saved.",
      detail:
        result.settings.status === "off"
          ? "Nothing will be prepared while it is off."
          : "Moti will prepare drafts for review. It cannot send anything.",
    };
  } catch (error) {
    return failure(error, "Could not save Away Mode. Please try again.");
  }
}

export async function setPermissionAction(formData: FormData): Promise<AwayActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const permission = String(formData.get("permission") ?? "");

  if (!contactId) return { ok: false, message: "Missing contact." };
  if (permission !== "draft_only" && permission !== "silent") {
    return { ok: false, message: "Choose either drafts or silent." };
  }

  try {
    const { supabase, userId } = await requireSession();
    const contact = await requireContact(supabase, userId, contactId);

    await setContactPermission(supabase, userId, contactId, permission);
    await recordAwayEvent(supabase, {
      userId,
      contactId,
      kind: "permission_changed",
      detail: `${contact.display_name}: ${permission === "silent" ? "silent" : "drafts allowed"}`,
      data: { permission },
    });

    revalidateAway();
    revalidatePath(`/contacts/${contactId}`);

    return {
      ok: true,
      message:
        permission === "silent"
          ? `Moti will prepare nothing for ${contact.display_name}.`
          : `Moti may prepare drafts for ${contact.display_name}.`,
    };
  } catch (error) {
    return failure(error, "Could not update that contact.");
  }
}

export async function clearPermissionAction(formData: FormData): Promise<AwayActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return { ok: false, message: "Missing contact." };

  try {
    const { supabase, userId } = await requireSession();
    await clearContactPermission(supabase, userId, contactId);
    revalidateAway();
    return { ok: true, message: "That contact now follows your default setting." };
  } catch (error) {
    return failure(error, "Could not reset that contact.");
  }
}

/**
 * Records the user's decision on a prepared reply.
 *
 * Approval is a record of intent, not a send. The wording of the success message
 * says so, because a user who believes Moti messaged someone on their behalf
 * would be badly misled.
 */
export async function decidePreparedReplyAction(formData: FormData): Promise<AwayActionResult> {
  const replyId = String(formData.get("replyId") ?? "");
  const decision = String(formData.get("decision") ?? "");

  if (!replyId) return { ok: false, message: "Missing reply." };
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, message: "Choose approve or discard." };
  }

  try {
    const { supabase, userId } = await requireSession();

    const existing = await getPreparedReply(supabase, userId, replyId);
    if (!existing) return { ok: false, message: "That reply no longer exists." };

    await decidePreparedReply(supabase, userId, replyId, decision);
    await recordAwayEvent(supabase, {
      userId,
      contactId: existing.contact_id,
      kind: decision === "approved" ? "reply_approved" : "reply_rejected",
      detail: decision === "approved" ? "Prepared reply accepted" : "Prepared reply discarded",
    });

    revalidateAway();

    return {
      ok: true,
      message:
        decision === "approved"
          ? "Marked as accepted. Copy it and send it yourself — Moti cannot send messages."
          : "Discarded. Nothing was sent.",
    };
  } catch (error) {
    return failure(error, "Could not record that decision.");
  }
}
