"use server";

/**
 * Import server action: the full upload -> parse -> store path.
 *
 * Deliberately conservative:
 *   - the file is hashed first, so an identical export cannot be imported twice,
 *   - the raw file is stored in a private bucket before parsing,
 *   - messages are only written once parsing succeeds,
 *   - if sender attribution is ambiguous the import is parked in `needs_review`
 *     rather than producing messages with guessed directions.
 */

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isAppError, ValidationError } from "@/lib/errors";
import { MAX_UPLOAD_BYTES, importUploadMetaSchema } from "@/lib/validation/schemas";
import { requireSession } from "@/server/auth/session";
import { getContact } from "@/server/contacts/repository";
import { ingestWhatsAppExport } from "@/server/imports/ingest";
import { CHAT_IMPORTS_BUCKET, buildStoragePath } from "@/server/imports/repository";

export type ImportActionResult = {
  ok: boolean;
  message: string;
  importId?: string;
  needsReview?: boolean;
  stats?: {
    messages: number;
    participants: string[];
    warnings: number;
    skippedLines: number;
  };
};

export async function uploadAndParseImportAction(formData: FormData): Promise<ImportActionResult> {
  const file = formData.get("file");
  const contactIdRaw = formData.get("contactId");
  const contactId =
    typeof contactIdRaw === "string" && contactIdRaw.trim().length > 0 ? contactIdRaw.trim() : null;

  if (!(file instanceof File)) {
    return { ok: false, message: "Choose the exported .txt file first." };
  }

  const meta = importUploadMetaSchema.safeParse({
    filename: file.name,
    byteSize: file.size,
    contactId: contactId ?? undefined,
  });

  if (!meta.success) {
    const first = meta.error.issues[0];
    return { ok: false, message: first?.message ?? "That file cannot be imported." };
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

  // Guard against attaching an import to someone else's contact before we upload.
  if (contactId) {
    const contact = await getContact(supabase, userId, contactId);
    if (!contact) return { ok: false, message: "That contact does not exist or is not yours." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const importId = randomUUID();
  const storagePath = buildStoragePath(userId, importId, file.name);

  // Store the original file first: if parsing fails, the user still has the source.
  const upload = await supabase.storage
    .from(CHAT_IMPORTS_BUCKET)
    .upload(storagePath, bytes, { contentType: "text/plain", upsert: false });

  if (upload.error) {
    return { ok: false, message: `Could not store the file: ${upload.error.message}` };
  }

  try {
    // WhatsApp .txt exports are UTF-8; decode explicitly so the parser never
    // receives replacement characters it would treat as text.
    const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    const result = await ingestWhatsAppExport({
      userId,
      supabase,
      importId,
      filename: file.name,
      content,
      byteSize: file.size,
      checksum,
      contactId,
    });

    revalidatePath("/imports");
    if (contactId) revalidatePath(`/contacts/${contactId}`);

    if (result.review.required) {
      return {
        ok: true,
        importId: result.chatImport.id,
        needsReview: true,
        message:
          result.review.reason ??
          "This export needs a quick check before Moti AI can attribute the messages.",
        stats: {
          messages: result.parse.parsedMessages,
          participants: result.parse.detectedParticipants,
          warnings: result.parse.warnings.length,
          skippedLines: result.parse.skippedLines,
        },
      };
    }

    return {
      ok: true,
      importId: result.chatImport.id,
      message: `Imported ${result.parse.parsedMessages.toLocaleString("en-GB")} messages.`,
      stats: {
        messages: result.parse.parsedMessages,
        participants: result.parse.detectedParticipants,
        warnings: result.parse.warnings.length,
        skippedLines: result.parse.skippedLines,
      },
    };
  } catch (error) {
    // Leave the stored file in place for inspection; record the failure via the
    // import row (ingest updates status before rethrowing).
    if (isAppError(error)) return { ok: false, message: error.userMessage };
    if (error instanceof ValidationError) return { ok: false, message: error.userMessage };

    console.error("[moti] import failed", error);
    const reason = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, message: `Import failed: ${reason.slice(0, 300)}` };
  }
}
