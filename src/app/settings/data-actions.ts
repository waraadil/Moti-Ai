"use server";

/**
 * Data deletion actions.
 *
 * Two rules govern everything here:
 *
 *   1. **Never claim nothing happened.** A deletion either rolled back in the
 *      database (so no records went) or committed (so they did). The message
 *      says which. Previously every failure said "nothing was changed", which
 *      was false when a later statement failed after earlier ones committed.
 *
 *   2. **Never claim completion while work remains.** If storage cleanup is
 *      still outstanding, the result says `complete: false` and names the files
 *      that are waiting. Reporting success then would leave the user believing
 *      their data is gone while a copy sits in a bucket.
 *
 * Confirmation phrases are checked here, on the server, not just in the browser.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { requireSession } from "@/server/auth/session";
import { requireContact } from "@/server/contacts/repository";
import {
  deleteContactData,
  deleteEverything,
  DeletionError,
  retryPendingCleanup,
} from "@/server/data/deletion";

export type DataActionResult = {
  ok: boolean;
  /** False when row deletion is done but files still need removing. */
  complete: boolean;
  message: string;
  detail?: string;
};

const CONTACT_PHRASE = "delete this conversation";
const ALL_PHRASE = "delete everything";

function totalRows(deleted: Record<string, number>): number {
  return Object.entries(deleted)
    .filter(([table]) => table !== "profile_anonymised")
    .reduce((sum, [, count]) => sum + count, 0);
}

/** Builds the honest summary of a finished-or-partly-finished deletion. */
function describe(params: {
  deleted: Record<string, number>;
  filesRemoved: number;
  queuedFiles: number;
  pendingCleanup: Array<{ path: string; error: string | null }>;
  profileAnonymised: boolean;
}): { message: string; detail: string; complete: boolean } {
  const rows = totalRows(params.deleted);

  if (params.pendingCleanup.length > 0) {
    /*
     * The important case. Records are gone and committed, but files are not.
     * Saying only "deleted" would be misleading, so both facts are stated and
     * the retry route is offered.
     */
    const names = params.pendingCleanup.slice(0, 3).map((item) => item.path).join(", ");
    const more =
      params.pendingCleanup.length > 3 ? ` and ${params.pendingCleanup.length - 3} more` : "";

    return {
      complete: false,
      message: `Records deleted (${rows.toLocaleString("en-GB")} rows), but ${params.pendingCleanup.length} stored file(s) could not be removed yet.`,
      detail: `Still pending: ${names}${more}. Use "Retry file cleanup" below; nothing will be reported complete until these are gone.`,
    };
  }

  const parts = [`${rows.toLocaleString("en-GB")} rows removed`];
  if (params.filesRemoved > 0) parts.push(`${params.filesRemoved} stored file(s) removed`);
  if (params.profileAnonymised) parts.push("profile details cleared");

  return {
    complete: true,
    message: "Deleted.",
    detail: `${parts.join(", ")}.`,
  };
}

function failure(error: unknown, fallback: string): DataActionResult {
  const message =
    error instanceof DeletionError
      ? error.message
      : isAppError(error)
        ? error.userMessage
        : error instanceof Error && error.message
          ? error.message
          : fallback;

  /*
   * A thrown deletion means the transaction rolled back, so this claim is now
   * accurate. The wording still tells the user to verify rather than asserting
   * a guarantee about state it cannot see.
   */
  return {
    ok: false,
    complete: false,
    message,
    detail: "The database rolled the whole operation back, so no records were partially removed.",
  };
}

export async function deleteContactDataAction(formData: FormData): Promise<DataActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "").trim().toLowerCase();

  if (!contactId) return { ok: false, complete: false, message: "Missing contact." };

  if (confirmation !== CONTACT_PHRASE) {
    return { ok: false, complete: false, message: `Type "${CONTACT_PHRASE}" exactly to confirm.` };
  }

  try {
    const { supabase, userId } = await requireSession();
    // Proves ownership and gives a name for the message before anything changes.
    const contact = await requireContact(supabase, userId, contactId);

    const outcome = await deleteContactData(supabase, userId, contactId);

    for (const path of ["/settings", "/contacts", "/imports", "/away", "/"]) {
      revalidatePath(path);
    }

    const described = describe(outcome);

    return {
      ok: true,
      complete: described.complete,
      message:
        described.message === "Deleted."
          ? `Deleted the conversation with ${contact.display_name}.`
          : described.message,
      detail: described.detail,
    };
  } catch (error) {
    return failure(error, "Could not delete that conversation.");
  }
}

export async function deleteEverythingAction(formData: FormData): Promise<DataActionResult> {
  const confirmation = String(formData.get("confirmation") ?? "").trim().toLowerCase();

  if (confirmation !== ALL_PHRASE) {
    return { ok: false, complete: false, message: `Type "${ALL_PHRASE}" exactly to confirm.` };
  }

  try {
    const { supabase, userId } = await requireSession();
    const outcome = await deleteEverything(supabase, userId, { anonymiseProfile: true });

    for (const path of ["/settings", "/contacts", "/imports", "/away", "/"]) {
      revalidatePath(path);
    }

    const described = describe(outcome);

    return {
      ok: true,
      complete: described.complete,
      message: described.complete
        ? "All your Moti AI data has been deleted."
        : described.message,
      detail: `${described.detail} Your sign-in account still exists; ask your deployment owner to remove it if you want that too.`,
    };
  } catch (error) {
    return failure(error, "Could not delete your data.");
  }
}

/**
 * Retries storage removal without deleting further rows.
 *
 * This is what makes the workflow retryable: a failed file removal is not a dead
 * end, and the outcome is reported honestly each time.
 */
export async function retryCleanupAction(): Promise<DataActionResult> {
  try {
    const { supabase, userId } = await requireSession();
    const result = await retryPendingCleanup(supabase, userId);

    revalidatePath("/settings");

    if (result.pendingCleanup.length === 0) {
      return {
        ok: true,
        complete: true,
        message:
          result.filesRemoved > 0
            ? `Removed ${result.filesRemoved} outstanding file(s). Deletion is now complete.`
            : "There is nothing left to clean up.",
        detail: "No stored files remain for your deleted data.",
      };
    }

    return {
      ok: false,
      complete: false,
      message: `${result.pendingCleanup.length} file(s) still could not be removed.`,
      detail: `${result.pendingCleanup[0]?.error ?? "Unknown storage error"}. Try again shortly; the records are already deleted.`,
    };
  } catch (error) {
    return failure(error, "Could not retry the file cleanup.");
  }
}
