/**
 * Chat import data access.
 *
 * Import lifecycle (see supabase/migrations/0003):
 *   uploaded -> parsing -> (completed | needs_review | failed)
 *
 * The upload route writes the `uploaded` row and the object; the parse step is
 * a separate function so a long-running parser can be retried without the user
 * re-uploading the file.
 */

import "server-only";

import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type {
  ChatImportRow,
  ChatImportStatus,
  Json,
  TablesUpdate,
} from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { ParsedMessage, ParseWarning } from "@/lib/conversations/parser";

export const CHAT_IMPORTS_BUCKET = "chat-imports";

/** Deterministic storage path: <user_id>/<import_id>/<filename>. Matches the policies. */
export function buildStoragePath(userId: string, importId: string, filename: string): string {
  // Strip path separators so a crafted filename cannot escape the user's folder.
  const safeName = filename.replace(/[/\\]/g, "_").slice(0, 200);
  return `${userId}/${importId}/${safeName}`;
}

export async function listImports(
  supabase: ServerSupabaseClient,
  userId: string,
  options: { contactId?: string; limit?: number } = {},
): Promise<ChatImportRow[]> {
  let query = supabase
    .from("chat_imports")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 50);

  if (options.contactId) query = query.eq("contact_id", options.contactId);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getImport(
  supabase: ServerSupabaseClient,
  userId: string,
  importId: string,
): Promise<ChatImportRow | null> {
  const { data, error } = await supabase
    .from("chat_imports")
    .select("*")
    .eq("user_id", userId)
    .eq("id", importId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function createImport(
  supabase: ServerSupabaseClient,
  params: {
    userId: string;
    importId: string;
    contactId: string | null;
    filename: string;
    byteSize: number;
    checksum: string;
  },
): Promise<ChatImportRow> {
  const { data, error } = await supabase
    .from("chat_imports")
    .insert({
      id: params.importId,
      user_id: params.userId,
      contact_id: params.contactId,
      source: "whatsapp_txt_export",
      status: "uploaded",
      storage_path: buildStoragePath(params.userId, params.importId, params.filename),
      original_filename: params.filename,
      byte_size: params.byteSize,
      checksum: params.checksum,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError(
        "This exact export has already been imported. Importing it again would duplicate messages.",
      );
    }
    throw error;
  }

  return data;
}

export async function getImportByChecksum(
  supabase: ServerSupabaseClient,
  userId: string,
  checksum: string,
): Promise<ChatImportRow | null> {
  const { data, error } = await supabase
    .from("chat_imports")
    .select("*")
    .eq("user_id", userId)
    .eq("checksum", checksum)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function updateImportStatus(
  supabase: ServerSupabaseClient,
  userId: string,
  importId: string,
  patch: {
    status: ChatImportStatus;
    errorMessage?: string | null;
    detectedParticipants?: string[];
    totalLines?: number;
    parsedMessages?: number;
    skippedLines?: number;
    parseWarnings?: ParseWarning[];
    startedAt?: string | null;
    completedAt?: string | null;
    contactId?: string | null;
  },
): Promise<ChatImportRow> {
  const update: TablesUpdate<"chat_imports"> = { status: patch.status };

  if (patch.errorMessage !== undefined) update.error_message = patch.errorMessage;
  if (patch.detectedParticipants !== undefined) {
    update.detected_participants = patch.detectedParticipants;
  }
  if (patch.totalLines !== undefined) update.total_lines = patch.totalLines;
  if (patch.parsedMessages !== undefined) update.parsed_messages = patch.parsedMessages;
  if (patch.skippedLines !== undefined) update.skipped_lines = patch.skippedLines;
  if (patch.parseWarnings !== undefined) {
    update.parse_warnings = patch.parseWarnings as unknown as Json;
  }
  if (patch.startedAt !== undefined) update.started_at = patch.startedAt;
  if (patch.completedAt !== undefined) update.completed_at = patch.completedAt;
  if (patch.contactId !== undefined) update.contact_id = patch.contactId;

  const { data, error } = await supabase
    .from("chat_imports")
    .update(update)
    .eq("user_id", userId)
    .eq("id", importId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("That import does not exist or is not yours.");
  return data;
}

/**
 * Builds message rows for bulk insert.
 *
 * `source_fingerprint` makes re-parsing idempotent: it is derived from the
 * import id plus the line position and timestamp, so a repeated parse of the
 * same file collides on `messages_import_fingerprint_key` instead of
 * duplicating the conversation.
 */
export function buildMessageRows(params: {
  userId: string;
  importId: string;
  contactId: string;
  messages: ParsedMessage[];
  directions: Array<{ direction: "outgoing" | "incoming" | "system" | "unknown" }>;
}): Array<{
  user_id: string;
  chat_import_id: string;
  contact_id: string;
  direction: "outgoing" | "incoming" | "system" | "unknown";
  kind: ParsedMessage["kind"];
  sender_label: string | null;
  sent_at: string | null;
  body: string | null;
  raw_line: string;
  line_number: number;
  media_filename: string | null;
  is_forwarded: boolean;
  source_fingerprint: string;
}> {
  if (params.messages.length !== params.directions.length) {
    throw new ValidationError("Message and direction counts disagree.");
  }

  return params.messages.map((message, index) => {
    const direction = params.directions[index]?.direction ?? "unknown";

    return {
      user_id: params.userId,
      chat_import_id: params.importId,
      contact_id: params.contactId,
      direction,
      kind: message.kind,
      sender_label: message.senderLabel,
      sent_at: message.sentAt ? message.sentAt.toISOString() : null,
      body: message.body,
      raw_line: message.rawLine.slice(0, 4000),
      line_number: message.lineNumber,
      media_filename: message.mediaFilename,
      is_forwarded: message.isForwarded,
      source_fingerprint: `${params.importId}:${message.lineNumber}`,
    };
  });
}

/** Inserts messages in chunks to stay well under request/statement limits. */
export async function insertMessages(
  supabase: ServerSupabaseClient,
  rows: ReturnType<typeof buildMessageRows>,
  chunkSize = 500,
): Promise<number> {
  let inserted = 0;

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const { error, count } = await supabase.from("messages").insert(chunk, { count: "exact" });

    if (error) throw error;
    inserted += count ?? chunk.length;
  }

  return inserted;
}

/** Signed download URL for the original export file. Short-lived by design. */
export async function createImportDownloadUrl(
  supabase: ServerSupabaseClient,
  storagePath: string,
  expiresInSeconds = 60,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(CHAT_IMPORTS_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}
