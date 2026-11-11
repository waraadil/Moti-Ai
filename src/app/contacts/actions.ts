"use server";

/**
 * Contact server actions.
 *
 * Every action re-derives the user from the session; no user id is ever accepted
 * from the client.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { createContactSchema } from "@/lib/validation/schemas";
import { requireSession } from "@/server/auth/session";
import { createContact, updateContact } from "@/server/contacts/repository";

export type ActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

export async function createContactAction(formData: FormData): Promise<ActionResult> {
  const parsed = createContactSchema.safeParse({
    displayName: formData.get("displayName"),
    relationshipKind: formData.get("relationshipKind") || "unknown",
    phoneNumber: formData.get("phoneNumber") || undefined,
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { ok: false, message: "Check the highlighted fields.", fieldErrors };
  }

  try {
    const { supabase, userId } = await requireSession();
    const contact = await createContact(supabase, userId, parsed.data);
    revalidatePath("/contacts");
    return { ok: true, message: `Added ${contact.display_name}.` };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] create contact failed", error);
    return { ok: false, message: "Could not save that contact. Please try again." };
  }
}

export async function archiveContactAction(formData: FormData): Promise<ActionResult> {
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.length === 0) {
    return { ok: false, message: "Missing contact." };
  }

  try {
    const { supabase, userId } = await requireSession();
    // Archive, never delete: messages and analysis stay intact and recoverable.
    await updateContact(supabase, userId, contactId, { isArchived: true });
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${contactId}`);
    return { ok: true, message: "Contact archived." };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] archive contact failed", error);
    return { ok: false, message: "Could not archive that contact." };
  }
}
