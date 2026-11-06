"use server";

/**
 * Import server actions.
 *
 * Upload flow (two steps, matching the review requirements):
 *   1. `uploadImportAction`  — hash, dedupe, upload, validate, parse, park.
 *   2. `confirmImportAction` — the user confirms participants and contact;
 *      only then are messages written.
 *
 * The checksum is computed from the bytes *before* uploading, and the duplicate
 * check runs before the upload too, so a repeat upload never writes an object.
 * If anything after the upload fails, the object is removed.
 */

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import {
  MAX_UPLOAD_BYTES,
  confirmParticipantsSchema,
  importUploadMetaSchema,
} from "@/lib/validation/schemas";
import { requireSession } from "@/server/auth/session";
import { getContact } from "@/server/contacts/repository";
import {
  confirmImportParticipants,
  discardImport,
  ingestWhatsAppExport,
} from "@/server/imports/ingest";
import {
  CHAT_IMPORTS_BUCKET,
  buildStoragePath,
  getImportByChecksum,
  removeImportObjectForUser,
} from "@/server/imports/repository";

export type UploadActionResult = {
  ok: boolean;
  message: string;
  /** Set when the import was parked and needs participant confirmation. */
  importId?: string;
  review?: {
    participants: string[];
    suggestedSelfLabels: string[];
    selfLabelConfident: boolean;
    reason: string | null;
    parsedMessages: number;
    dateOrder: string;
    contactId: string;
  };
};

export async function uploadImportAction(formData: FormData): Promise<UploadActionResult> {
  const file = formData.get("file");
  const contactIdRaw = formData.get("contactId");
  const dateOrderRaw = formData.get("dateOrder");

  if (!(file instanceof File)) {
    return { ok: false, message: "Choose the .txt export first." };
  }

  const contactId =
    typeof contactIdRaw === "string" && contactIdRaw.trim().length > 0 ? contactIdRaw.trim() : "";

  const meta = importUploadMetaSchema.safeParse({
    filename: file.name,
    byteSize: file.size,
    contactId,
    dateOrder: typeof dateOrderRaw === "string" ? dateOrderRaw : undefined,
  });

  if (!meta.success) {
    return { ok: false, message: meta.error.issues[0]?.message ?? "That file cannot be imported." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "Exports must be 50 MB or smaller." };
  }

  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    return { ok: false, message: "You need to be signed in to import a chat." };
  }

  const { supabase, userId } = session;

  const contact = await getContact(supabase, userId, meta.data.contactId);
  if (!contact) return { ok: false, message: "That contact does not exist or is not yours." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");

  // --- Duplicate check BEFORE the upload ---------------------------------
  const duplicate = await getImportByChecksum(supabase, userId, checksum);
  if (duplicate) {
    return {
      ok: false,
      message:
        "This exact export has already been imported. Nothing was uploaded or changed. " +
        "Open the existing import below instead.",
      importId: duplicate.id,
    };
  }

  const importId = randomUUID();
  const storagePath = buildStoragePath(userId, importId, file.name);

  const upload = await supabase.storage
    .from(CHAT_IMPORTS_BUCKET)
    .upload(storagePath, bytes, { contentType: "text/plain", upsert: false });

  if (upload.error) {
    return { ok: false, message: `Could not store the file: ${upload.error.message}` };
  }

  // WhatsApp .txt exports are UTF-8; decode explicitly so the parser never sees
  // replacement characters it would treat as message text.
  const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  try {
    const outcome = await ingestWhatsAppExport({
      userId,
      supabase,
      importId,
      filename: file.name,
      content,
      byteSize: file.size,
      checksum,
      storagePath,
      dateOrder: meta.data.dateOrder,
    });

    if (!outcome.ok) {
      // Rejections clean up their own object; the message explains why.
      revalidatePath("/imports");
      return { ok: false, message: outcome.message };
    }

    revalidatePath("/imports");

    return {
      ok: true,
      importId: outcome.chatImport.id,
      message: outcome.parse.selfLabelConfident
        ? `Read ${outcome.parse.parsedMessages.toLocaleString("en-GB")} messages. Confirm the participants to store them.`
        : `Read ${outcome.parse.parsedMessages.toLocaleString("en-GB")} messages. Tell Moti AI which participant is you.`,
      review: {
        participants: outcome.parse.detectedParticipants,
        suggestedSelfLabels: outcome.parse.suggestedSelfLabels,
        selfLabelConfident: outcome.parse.selfLabelConfident,
        reason: outcome.parse.reviewReason,
        parsedMessages: outcome.parse.parsedMessages,
        dateOrder: outcome.parse.dateOrder,
        contactId: contact.id,
      },
    };
  } catch (error) {
    // The import row may or may not exist; make sure the object does not survive
    // if the row was never created.
    await removeImportObjectForUser(supabase, userId, storagePath);
    revalidatePath("/imports");

    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] import failed", error);
    const reason = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, message: `Import failed: ${reason.slice(0, 300)}` };
  }
}

export type ConfirmActionResult = {
  ok: boolean;
  message: string;
  storedMessages?: number;
  contactId?: string;
};

export async function confirmImportAction(formData: FormData): Promise<ConfirmActionResult> {
  const parsed = confirmParticipantsSchema.safeParse({
    importId: formData.get("importId"),
    contactId: formData.get("contactId"),
    selfLabels: formData.getAll("selfLabels").filter((value) => typeof value === "string"),
    dateOrder: formData.get("dateOrder") ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check your selection." };
  }

  try {
    const { supabase, userId } = await requireSession();

    const result = await confirmImportParticipants({
      userId,
      supabase,
      importId: parsed.data.importId,
      contactId: parsed.data.contactId,
      selfLabels: parsed.data.selfLabels,
      dateOrder: parsed.data.dateOrder,
    });

    revalidatePath("/imports");
    revalidatePath("/contacts");
    revalidatePath(`/contacts/${parsed.data.contactId}`);

    return {
      ok: true,
      message: `Stored ${result.storedMessages.toLocaleString("en-GB")} messages with ${result.contactLabel}.`,
      storedMessages: result.storedMessages,
      contactId: parsed.data.contactId,
    };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] confirm import failed", error);
    return { ok: false, message: "Could not save those messages. Please try again." };
  }
}

export async function discardImportAction(formData: FormData): Promise<ConfirmActionResult> {
  const importId = formData.get("importId");
  if (typeof importId !== "string" || importId.length === 0) {
    return { ok: false, message: "Missing import." };
  }

  try {
    const { supabase, userId } = await requireSession();
    const result = await discardImport({ userId, supabase, importId });
    revalidatePath("/imports");
    return {
      ok: true,
      message: result.objectRemoved
        ? "Import discarded and the uploaded file was removed."
        : "Import discarded.",
    };
  } catch (error) {
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    console.error("[moti] discard import failed", error);
    return { ok: false, message: "Could not discard that import." };
  }
}
