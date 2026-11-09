"use server";

/**
 * Data deletion actions.
 *
 * Both require the user to type a confirmation phrase. That is not ceremony: an
 * irreversible action reached by a single misplaced click is a bug, so the
 * phrase is checked on the server, not only in the browser.
 *
 * Neither action deletes the Supabase Auth account. That is a separate decision
 * with a different blast radius, and pretending otherwise would leave a user
 * believing their login was gone when it is not.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import { deleteContactData, deleteEverything } from "@/server/data/deletion";

export type DataActionResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

const CONTACT_PHRASE = "delete this conversation";
const ALL_PHRASE = "delete everything";

function summarise(deleted: Record<string, number>): string {
  const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
  return `${total.toLocaleString("en-GB")} ${total === 1 ? "row" : "rows"} removed`;
}

function failure(error: unknown, fallback: string): DataActionResult {
  if (isAppError(error)) return { ok: false, message: error.userMessage };
  if (error instanceof Error && error.message) return { ok: false, message: error.message };
  return { ok: false, message: fallback };
}

export async function deleteContactDataAction(formData: FormData): Promise<DataActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "").trim().toLowerCase();

  if (!contactId) return { ok: false, message: "Missing contact." };

  if (confirmation !== CONTACT_PHRASE) {
    return {
      ok: false,
      message: `Type "${CONTACT_PHRASE}" exactly to confirm.`,
    };
  }

  try {
    const { supabase, userId } = await requireSession();
    // Proves ownership before anything is destroyed.
    const contact = await requireContact(supabase, userId, contactId);

    const report = await deleteContactData(supabase, userId, contactId);

    revalidatePath("/settings");
    revalidatePath("/contacts");
    revalidatePath("/imports");
    revalidatePath("/away");

    return {
      ok: true,
      message: `Deleted the conversation with ${contact.display_name}.`,
      detail: `${summarise(report.deleted)}${report.filesRemoved > 0 ? `, ${report.filesRemoved} stored file(s) removed` : ""}.`,
    };
  } catch (error) {
    return failure(error, "Could not delete that conversation. Nothing was changed.");
  }
}

export async function deleteEverythingAction(formData: FormData): Promise<DataActionResult> {
  const confirmation = String(formData.get("confirmation") ?? "").trim().toLowerCase();

  if (confirmation !== ALL_PHRASE) {
    return { ok: false, message: `Type "${ALL_PHRASE}" exactly to confirm.` };
  }

  try {
    const { supabase, userId } = await requireSession();
    const report = await deleteEverything(supabase, userId);

    for (const path of ["/settings", "/contacts", "/imports", "/away", "/"]) {
      revalidatePath(path);
    }

    return {
      ok: true,
      message: "All your Moti AI data has been deleted.",
      detail: `${summarise(report.deleted)}${report.filesRemoved > 0 ? `, ${report.filesRemoved} stored file(s) removed` : ""}. Your sign-in account still exists; ask your deployment owner to remove it if you want that too.`,
    };
  } catch (error) {
    return failure(error, "Could not delete your data. Nothing was changed.");
  }
}
