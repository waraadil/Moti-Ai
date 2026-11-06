/**
 * Import ingest orchestration.
 *
 * Two deliberate stages, because attributing messages to "you" versus "them" is
 * the step that decides whether every downstream analysis is correct:
 *
 *   1. `ingestWhatsAppExport`  — validate the file, parse it, record the import
 *      *without writing any messages*. It always finishes in `needs_review` so
 *      the user can confirm participants first.
 *   2. `confirmImportParticipants` — the user confirms who they are and which
 *      contact the chat belongs to; only then are messages written and the
 *      import marked `completed`.
 *
 * The one exception to stage 1 is a file that cannot be imported at all (empty,
 * unreadable, group chat, .zip). Those are rejected outright, the storage object
 * is cleaned up, and no `completed` row is ever created for them.
 */

import "server-only";

import { AppError, ValidationError } from "@/lib/errors";
import type { ChatImportRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  parseWhatsAppExport,
  resolveContactLabel,
  resolveDirections,
  suggestSelfLabels,
  validateParsedExport,
  type ParseWarning,
} from "@/lib/conversations/parser";
import { getContact } from "@/server/contacts/repository";
import {
  buildMessageRows,
  createImport,
  deleteImport,
  getImport,
  getImportByChecksum,
  insertMessages,
  removeImportObjectForUser,
  updateImportStatus,
} from "./repository";

export const MAX_MESSAGES_PER_IMPORT = 200_000;

export type DateOrder = "DMY" | "MDY";

export type IngestRequest = {
  userId: string;
  supabase: ServerSupabaseClient;
  /** Stable id generated before the storage upload so the path matches. */
  importId: string;
  filename: string;
  content: string;
  byteSize: number;
  checksum: string;
  /** Storage path of the uploaded object, used for cleanup on rejection. */
  storagePath: string;
  dateOrder: DateOrder;
};

/** A rejection that means "this file will never be importable". */
export type IngestRejection = {
  ok: false;
  code:
    | "empty_file"
    | "no_valid_messages"
    | "unsupported_format"
    | "group_conversation"
    | "no_participants"
    | "duplicate";
  message: string;
  /** True when the uploaded object was removed from Storage. */
  objectRemoved: boolean;
  duplicateOfImportId?: string;
};

export type IngestAccepted = {
  ok: true;
  status: "needs_review";
  chatImport: ChatImportRow;
  parse: {
    totalLines: number;
    skippedLines: number;
    parsedMessages: number;
    storedMessages: number;
    detectedParticipants: string[];
    warnings: ParseWarning[];
    suggestedSelfLabels: string[];
    /** True only when a "You"/"Me" label was found in a direct chat. */
    selfLabelConfident: boolean;
    reviewReason: string | null;
    dateOrder: DateOrder;
  };
};

export type IngestOutcome = IngestAccepted | IngestRejection;

/**
 * Validates and parses an uploaded export, then parks it for confirmation.
 *
 * No message rows are written here. That is intentional: a wrong self-label
 * produces a permanently wrong conversation, and messages are immutable once
 * stored, so the expensive mistake is unrecoverable.
 */
export async function ingestWhatsAppExport(request: IngestRequest): Promise<IngestOutcome> {
  const { supabase, userId } = request;

  // Duplicate check happens *before* anything is written. The caller also checks
  // the checksum before uploading; this is the authoritative second check.
  const existing = await getImportByChecksum(supabase, userId, request.checksum);
  if (existing) {
    const cleanup = await removeImportObjectForUser(supabase, userId, request.storagePath);
    return {
      ok: false,
      code: "duplicate",
      message:
        "This exact export has already been imported, so it was not imported again. " +
        "Nothing in your existing data changed.",
      objectRemoved: cleanup.removed,
      duplicateOfImportId: existing.id,
    };
  }

  const parse = parseWhatsAppExport(request.content, {
    dateOrder: request.dateOrder,
    maxMessages: MAX_MESSAGES_PER_IMPORT,
  });

  const validation = validateParsedExport(parse);

  if (!validation.ok && validation.issue) {
    // Rejected before any database row exists: remove the object and report.
    const cleanup = await removeImportObjectForUser(supabase, userId, request.storagePath);
    return {
      ok: false,
      code: validation.issue.code,
      message: validation.issue.message,
      objectRemoved: cleanup.removed,
    };
  }

  const assessment = suggestSelfLabels(parse.detectedParticipants);

  const chatImport = await createImport(supabase, {
    userId,
    importId: request.importId,
    // The contact is confirmed by the user later; nothing is assumed here.
    contactId: null,
    filename: request.filename,
    byteSize: request.byteSize,
    checksum: request.checksum,
  });

  const now = new Date().toISOString();

  try {
    const updated = await updateImportStatus(supabase, userId, chatImport.id, {
      status: "needs_review",
      totalLines: parse.totalLines,
      // Nothing has been stored yet, so this stays 0 until confirmation.
      parsedMessages: 0,
      skippedLines: parse.skippedLines,
      detectedParticipants: parse.detectedParticipants,
      // Record the date order here, so confirming later cannot silently fall
      // back to the default and shift every timestamp.
      parseWarnings: withResolvedSelfLabels(parse.warnings, [], request.dateOrder),
      startedAt: now,
      completedAt: null,
      errorMessage: assessment.confident ? null : assessment.reason,
    });

    return {
      ok: true,
      status: "needs_review",
      chatImport: updated,
      parse: {
        totalLines: parse.totalLines,
        skippedLines: parse.skippedLines,
        parsedMessages: parse.messages.filter((message) => message.kind !== "system").length,
        storedMessages: 0,
        detectedParticipants: parse.detectedParticipants,
        warnings: parse.warnings,
        suggestedSelfLabels: assessment.labels,
        selfLabelConfident: assessment.confident,
        reviewReason: assessment.confident ? null : assessment.reason,
        dateOrder: request.dateOrder,
      },
    };
  } catch (error) {
    // The row exists but could not be updated: remove both so no half-state
    // import lingers, then surface the failure.
    await removeImportObjectForUser(supabase, userId, request.storagePath);
    await deleteImport(supabase, userId, chatImport.id).catch(() => undefined);
    throw error;
  }
}

export type ConfirmRequest = {
  userId: string;
  supabase: ServerSupabaseClient;
  importId: string;
  /** Contact the conversation belongs to; may differ from any earlier choice. */
  contactId: string;
  /** Sender labels that belong to the Moti user. */
  selfLabels: string[];
  /** Optional override so the preview and the import cannot disagree. */
  dateOrder?: DateOrder;
};

export type ConfirmResult = {
  chatImport: ChatImportRow;
  storedMessages: number;
  contactLabel: string;
  selfLabels: string[];
};

/**
 * Second stage: the user has confirmed participants, so messages can be written.
 *
 * Reads the original file back from Storage and re-parses with the *same*
 * date-order the user saw in the preview, so what they confirmed is exactly what
 * gets stored.
 */
export async function confirmImportParticipants(request: ConfirmRequest): Promise<ConfirmResult> {
  const { supabase, userId, importId } = request;

  const chatImport = await getImport(supabase, userId, importId);
  if (!chatImport) {
    throw new ValidationError({}, "That import does not exist or is not yours.");
  }

  if (chatImport.status === "completed") {
    throw new AppError(
      "conflict",
      "This import has already been confirmed and its messages are stored. " +
        "Upload the export again to import it differently.",
    );
  }

  const contact = await getContact(supabase, userId, request.contactId);
  if (!contact) {
    throw new ValidationError({}, "The selected contact does not exist or is not yours.");
  }

  // --- Preserve the date order the user previewed -------------------------
  const dateOrder = request.dateOrder ?? readDateOrder(chatImport.parse_warnings);

  const download = await supabase.storage.from("chat-imports").download(chatImport.storage_path);

  if (download.error || !download.data) {
    await updateImportStatus(supabase, userId, importId, {
      status: "failed",
      errorMessage: `Could not read the stored export back: ${download.error?.message ?? "unknown error"}`,
    });
    throw new AppError(
      "internal_error",
      "The stored export could not be read back. Upload the file again.",
      { cause: download.error },
    );
  }

  const content = await download.data.text();
  const parse = parseWhatsAppExport(content, { dateOrder, maxMessages: MAX_MESSAGES_PER_IMPORT });

  const validation = validateParsedExport(parse);
  if (!validation.ok && validation.issue) {
    await updateImportStatus(supabase, userId, importId, {
      status: "failed",
      errorMessage: validation.issue.message,
    });
    throw new ValidationError({}, validation.issue.message);
  }

  // --- Validate the confirmed labels against what we actually parsed ------
  const participants = parse.detectedParticipants;
  const normalisedParticipants = new Map(
    participants.map((label) => [label.trim().toLowerCase(), label] as const),
  );

  const selfLabels: string[] = [];
  for (const candidate of request.selfLabels) {
    const canonical = normalisedParticipants.get(candidate.trim().toLowerCase());
    if (!canonical) {
      throw new ValidationError(
        {},
        `"${candidate}" is not one of the participants in this export (${participants.join(", ")}).`,
      );
    }
    if (!selfLabels.includes(canonical)) selfLabels.push(canonical);
  }

  if (selfLabels.length === 0) {
    throw new ValidationError({}, "Select which participant is you.");
  }

  if (selfLabels.length >= participants.length) {
    throw new ValidationError(
      {},
      "Every participant cannot be you. Select your own name and leave the other participant unselected.",
    );
  }

  const contactLabel = resolveContactLabel(participants, selfLabels);
  if (!contactLabel) {
    throw new ValidationError(
      {},
      "This export does not describe a one-to-one conversation, so it cannot be imported.",
    );
  }

  const directions = resolveDirections(parse.messages, selfLabels);

  const rows = buildMessageRows({
    userId,
    importId,
    contactId: contact.id,
    messages: parse.messages,
    directions,
  });

  const startedAt = new Date().toISOString();

  try {
    const storedMessages = await insertMessages(supabase, rows);

    const updated = await updateImportStatus(supabase, userId, importId, {
      status: "completed",
      contactId: contact.id,
      parsedMessages: storedMessages,
      totalLines: parse.totalLines,
      skippedLines: parse.skippedLines,
      detectedParticipants: participants,
      parseWarnings: withResolvedSelfLabels(parse.warnings, selfLabels, dateOrder),
      startedAt,
      completedAt: new Date().toISOString(),
      errorMessage: null,
    });

    return { chatImport: updated, storedMessages, contactLabel, selfLabels };
  } catch (error) {
    // Messages are immutable and the insert is idempotent per line, so leaving a
    // `failed` row (rather than deleting it) lets the user retry the same import
    // once the underlying problem is fixed.
    await updateImportStatus(supabase, userId, importId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 2000) : "Unknown error",
    });
    throw error;
  }
}

/** Removes a parked import and its stored file at the user's request. */
export async function discardImport(params: {
  userId: string;
  supabase: ServerSupabaseClient;
  importId: string;
}): Promise<{ objectRemoved: boolean }> {
  const { supabase, userId, importId } = params;

  const chatImport = await getImport(supabase, userId, importId);
  if (!chatImport) throw new ValidationError({}, "That import does not exist or is not yours.");

  if (chatImport.status === "completed") {
    throw new AppError(
      "conflict",
      "This import already has stored messages. Delete the contact's messages instead.",
    );
  }

  const cleanup = await removeImportObjectForUser(supabase, userId, chatImport.storage_path);
  await deleteImport(supabase, userId, importId);

  return { objectRemoved: cleanup.removed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The date order is recorded as a parser warning so the confirmed import can be
 * re-parsed identically. Storing it in `parse_warnings` avoids a schema change
 * for a single enum while keeping it alongside the other parse metadata.
 */
export function withResolvedSelfLabels(
  warnings: ParseWarning[],
  selfLabels: readonly string[],
  dateOrder: DateOrder,
): ParseWarning[] {
  const withoutMeta = warnings.filter(
    (warning) => warning.code !== "ambiguous_date" || !warning.message.startsWith("dateOrder="),
  );

  return [
    {
      code: "ambiguous_date",
      line: 0,
      message: `dateOrder=${dateOrder}; selfLabels=${selfLabels.join("|")}`,
    },
    ...withoutMeta,
  ];
}

export function readDateOrder(warnings: unknown): DateOrder {
  if (!Array.isArray(warnings)) return "DMY";

  for (const entry of warnings) {
    if (typeof entry !== "object" || entry === null) continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message === "string" && message.startsWith("dateOrder=MDY")) return "MDY";
  }

  return "DMY";
}
