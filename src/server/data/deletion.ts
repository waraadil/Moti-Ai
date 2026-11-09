/**
 * Data deletion.
 *
 * Two separate operations, deliberately not one:
 *
 *   deleteContactData  — removes one conversation and everything derived from it
 *   deleteEverything   — removes all of the user's data
 *
 * Both are scoped by `user_id` on every statement. RLS would do this anyway, but
 * an explicit filter means a policy mistake cannot turn one user's deletion into
 * another user's loss.
 *
 * What is *not* deleted, and why:
 *   - the account itself (that is Supabase Auth, a separate decision)
 *   - rows belonging to anyone else
 *
 * What is deleted, exhaustively, in dependency order: derived analysis rows
 * first, source messages last, so an interrupted deletion never leaves a contact
 * whose messages are gone but whose analysis still claims to describe them.
 */

import "server-only";

import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type DeletionReport = {
  contactId: string | null;
  deleted: Record<string, number>;
  /** Files whose storage removal was attempted, for honesty about failures. */
  filesRemoved: number;
  fileErrors: string[];
};

/** Tables derived from a contact, in the order they must be removed. */
const CONTACT_SCOPED_TABLES = [
  "away_prepared_replies",
  "away_events",
  "away_contact_permissions",
  "reply_drafts",
  "conversation_snapshots",
  "analysis_runs",
  "analysis_versions",
  "memory_evidence",
  "memories",
  "relationship_contexts",
  "communication_profiles",
  "contact_aliases",
] as const;

export class DeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionError";
  }
}

/**
 * Counts rows matching the scope.
 *
 * Counted by an explicit select rather than trusting a delete's return value:
 * a delete that returns nothing is indistinguishable from a delete that matched
 * nothing, and the caller needs to tell those apart to report honestly.
 */
async function countRows(
  supabase: ServerSupabaseClient,
  userId: string,
  table: string,
  contactId: string | null,
): Promise<number> {
  let query = supabase.from(table as never).select("id").eq("user_id", userId);
  if (contactId) query = query.eq("contact_id", contactId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length;
}

/** Removes every row in `table` for this user, optionally narrowed to a contact. */
async function purge(
  supabase: ServerSupabaseClient,
  userId: string,
  table: string,
  contactId: string | null,
  report: Record<string, number>,
): Promise<void> {
  const found = await countRows(supabase, userId, table, contactId);
  if (found === 0) return;

  let query = supabase.from(table as never).delete().eq("user_id", userId);
  if (contactId) query = query.eq("contact_id", contactId);

  const { error } = await query.select("id");
  if (error) throw error;

  report[table] = found;
}

/**
 * Deletes one contact and everything derived from it.
 *
 * Storage objects for that contact's imports are removed first: if the file
 * removal fails, the user is told which file and the database rows are left
 * intact, so nothing is half-deleted and unretryable.
 */
export async function deleteContactData(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<DeletionReport> {
  const report: DeletionReport = {
    contactId,
    deleted: {},
    filesRemoved: 0,
    fileErrors: [],
  };

  // Find the uploads to remove from private storage.
  const { data: imports, error: importsError } = await supabase
    .from("chat_imports")
    .select("id, storage_path")
    .eq("user_id", userId)
    .eq("contact_id", contactId);

  if (importsError) throw importsError;

  const paths = (imports ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from("chat-imports").remove(paths);

    if (storageError) {
      /*
       * Refuse rather than proceed. Leaving the database rows means the user can
       * try again; deleting them would strand an orphaned file they can no
       * longer reach or account for.
       */
      throw new DeletionError(
        `Could not remove the stored export file(s), so nothing was deleted: ${storageError.message}`,
      );
    }
    report.filesRemoved = paths.length;
  }

  for (const table of CONTACT_SCOPED_TABLES) {
    await purge(supabase, userId, table, contactId, report.deleted);
  }

  // Messages own the evidence rows above them, so they go after them.
  await purge(supabase, userId, "messages", contactId, report.deleted);
  await purge(supabase, userId, "chat_imports", contactId, report.deleted);

  const { data: existing, error: existingError } = await supabase
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("id", contactId);

  if (existingError) throw existingError;

  const removed = (existing ?? []).length;
  if (removed === 0) {
    throw new DeletionError("That contact no longer exists, or is not yours.");
  }

  const { error: contactError } = await supabase
    .from("contacts")
    .delete()
    .eq("user_id", userId)
    .eq("id", contactId)
    .select("id");

  if (contactError) throw contactError;

  report.deleted.contacts = removed;

  return report;
}

/**
 * Deletes every row belonging to one user.
 *
 * Every table is listed explicitly rather than relying on a cascade, so adding a
 * table without adding it here is a visible omission rather than a silent leak.
 */
const ALL_USER_TABLES = [
  "away_prepared_replies",
  "away_events",
  "away_contact_permissions",
  "away_settings",
  "reply_drafts",
  "conversation_snapshots",
  "analysis_runs",
  "analysis_versions",
  "memory_evidence",
  "memories",
  "relationship_contexts",
  "communication_profiles",
  "contact_aliases",
  "messages",
  "chat_imports",
  "contacts",
] as const;

export async function deleteEverything(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<DeletionReport> {
  const report: DeletionReport = {
    contactId: null,
    deleted: {},
    filesRemoved: 0,
    fileErrors: [],
  };

  // Remove every stored file first, for the same reason as above.
  const { data: imports, error: importsError } = await supabase
    .from("chat_imports")
    .select("storage_path")
    .eq("user_id", userId);

  if (importsError) throw importsError;

  const paths = (imports ?? [])
    .map((row) => row.storage_path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from("chat-imports").remove(paths);
    if (storageError) {
      throw new DeletionError(
        `Could not remove the stored export file(s), so nothing was deleted: ${storageError.message}`,
      );
    }
    report.filesRemoved = paths.length;
  }

  for (const table of ALL_USER_TABLES) {
    await purge(supabase, userId, table, null, report.deleted);
  }

  return report;
}

/** True when the report is worth reassuring the user about, i.e. nothing failed. */
export function deletionSucceeded(report: DeletionReport): boolean {
  return report.fileErrors.length === 0;
}
