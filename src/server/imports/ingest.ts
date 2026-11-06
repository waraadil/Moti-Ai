/**
 * Import ingest orchestration.
 *
 * The one place that turns an uploaded file into stored messages. Kept out of
 * the route handler so it can be called from a background job later without
 * duplicating the rules:
 *
 *   - the same file is never imported twice,
 *   - messages are written in one ordered pass and are immutable afterwards,
 *   - a parse that cannot attribute senders is parked in `needs_review`
 *     instead of silently producing "unknown" directions.
 */

import "server-only";

import { AppError, ValidationError } from "@/lib/errors";
import type { ChatImportRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  parseWhatsAppExport,
  resolveDirections,
  suggestSelfLabels,
  type ParseResult,
} from "@/lib/conversations/parser";
import { getContact } from "@/server/contacts/repository";
import {
  buildMessageRows,
  createImport,
  getImportByChecksum,
  insertMessages,
  updateImportStatus,
} from "./repository";

export const MAX_MESSAGES_PER_IMPORT = 200_000;

export type IngestRequest = {
  userId: string;
  supabase: ServerSupabaseClient;
  /** Stable id generated before the storage upload so the path matches. */
  importId: string;
  filename: string;
  content: string;
  byteSize: number;
  checksum: string;
  contactId: string | null;
  dateOrder?: "DMY" | "MDY";
  /**
   * Sender labels belonging to the Moti user. When omitted, only an explicit
   * "You" label is trusted; otherwise the import is parked for review.
   */
  selfLabels?: string[];
};

export type IngestResult = {
  status: "completed" | "needs_review";
  chatImport: ChatImportRow;
  parse: Pick<ParseResult, "totalLines" | "skippedLines" | "detectedParticipants" | "warnings"> & {
    parsedMessages: number;
  };
  review: { required: boolean; reason: string | null };
};

export async function ingestWhatsAppExport(request: IngestRequest): Promise<IngestResult> {
  const { supabase, userId } = request;

  // Guard: refuse to re-import a file we have already processed.
  const existing = await getImportByChecksum(supabase, userId, request.checksum);
  if (existing) {
    throw new AppError("conflict", "This exact export has already been imported.", {
      details: { chatImportId: existing.id, status: existing.status },
    });
  }

  if (request.contactId) {
    const contact = await getContact(supabase, userId, request.contactId);
    if (!contact) {
      throw new ValidationError("The selected contact does not exist or is not yours.");
    }
  }

  const chatImport = await createImport(supabase, {
    userId,
    importId: request.importId,
    contactId: request.contactId,
    filename: request.filename,
    byteSize: request.byteSize,
    checksum: request.checksum,
  });

  try {
    const parse = parseWhatsAppExport(request.content, {
      dateOrder: request.dateOrder ?? "DMY",
      maxMessages: MAX_MESSAGES_PER_IMPORT,
    });

    const selfLabels =
      request.selfLabels ??
      (() => {
        const suggestion = suggestSelfLabels(parse.detectedParticipants);
        return suggestion.confident ? suggestion.labels : [];
      })();

    const directions = resolveDirections(parse.messages, selfLabels);

    // Without a confirmed self-label we cannot build a communication profile for
    // each participant, so ask instead of guessing.
    const needsReview = selfLabels.length === 0 && parse.messages.length > 0;
    const reviewReason = needsReview ? suggestSelfLabels(parse.detectedParticipants).reason : null;

    let inserted = 0;

    if (!needsReview) {
      const rows = buildMessageRows({
        userId,
        importId: chatImport.id,
        contactId: request.contactId ?? "",
        messages: parse.messages,
        directions,
      });

      if (request.contactId) {
        inserted = await insertMessages(supabase, rows);
      }
    }

    const updated = await updateImportStatus(supabase, userId, chatImport.id, {
      status: needsReview ? "needs_review" : "completed",
      totalLines: parse.totalLines,
      parsedMessages: inserted,
      skippedLines: parse.skippedLines,
      detectedParticipants: parse.detectedParticipants,
      parseWarnings: parse.warnings,
      startedAt: new Date().toISOString(),
      completedAt: needsReview ? null : new Date().toISOString(),
      errorMessage: reviewReason,
    });

    return {
      status: needsReview ? "needs_review" : "completed",
      chatImport: updated,
      parse: {
        totalLines: parse.totalLines,
        skippedLines: parse.skippedLines,
        detectedParticipants: parse.detectedParticipants,
        warnings: parse.warnings,
        parsedMessages: inserted,
      },
      review: { required: needsReview, reason: reviewReason },
    };
  } catch (error) {
    // Record the failure so the user sees why, then rethrow for the caller.
    await updateImportStatus(supabase, userId, chatImport.id, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 2000) : "Unknown parse error",
    });
    throw error;
  }
}
