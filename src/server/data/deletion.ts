/**
 * Data deletion.
 *
 * Two operations, deliberately not one:
 *
 *   deleteContactData  — one conversation and everything derived from it
 *   deleteEverything   — all of the user's data
 *
 * ## Why the row deletion is a database function
 *
 * PostgREST cannot run several statements in one transaction from the client.
 * Deleting table by table from here therefore had a real failure mode: if the
 * fifth statement failed, the first four were already committed and there was
 * no record of which. The user was told "nothing was changed", which was false.
 *
 * So all row deletion happens inside `delete_contact_data` /
 * `delete_all_user_data` (migration 0011). Those run as a single transaction:
 * either every row goes or none does. They also derive the user from
 * `auth.uid()` rather than a parameter, so a bug here cannot ask the database to
 * delete another account's data.
 *
 * ## Why storage is separate
 *
 * Storage objects are not part of the database transaction and cannot be. They
 * are *queued* in `data_cleanup_jobs` during the transaction, then removed
 * afterwards. A removal that fails leaves its queue row in place, so:
 *
 *   - the operation is safe to retry (re-running only touches what is left),
 *   - the caller can distinguish "rows deleted" from "deletion complete",
 *   - and the UI is never told everything is done while a file remains.
 *
 * Nothing in this module reports success for work it has not verified.
 */

import "server-only";

import type { Json } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type DeletionOutcome = {
  /** True when every requested row is gone. */
  rowsDeleted: boolean;
  /** True only when rows are gone AND no queued file remains. */
  complete: boolean;
  /** Table name -> rows removed in this call. */
  deleted: Record<string, number>;
  /** Storage objects queued by the transaction. */
  queuedFiles: number;
  /** Storage objects whose removal succeeded in this call. */
  filesRemoved: number;
  /** Storage objects still queued after this call, with their last error. */
  pendingCleanup: Array<{ path: string; error: string | null }>;
  /** Profile anonymisation applied, for the whole-account case. */
  profileAnonymised: boolean;
};

export class DeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionError";
  }
}

/** Shape returned by both database functions. */
type RpcResult = {
  deleted: Record<string, number>;
  purge_contact: string | null;
  queued_files: number;
  complete: boolean;
};

function parseRpcResult(raw: Json | null): RpcResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  const deleted = candidate.deleted;

  return {
    deleted:
      deleted && typeof deleted === "object" && !Array.isArray(deleted)
        ? (deleted as Record<string, number>)
        : {},
    purge_contact: typeof candidate.purge_contact === "string" ? candidate.purge_contact : null,
    queued_files: typeof candidate.queued_files === "number" ? candidate.queued_files : 0,
    complete: candidate.complete === true,
  };
}

/**
 * Runs every queued storage removal for this user.
 *
 * One object per call so a single failure cannot block the others. A failed
 * removal is recorded against its queue row: the row stays, the count is
 * visible, and the next attempt tries again.
 */
async function drainCleanupQueue(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<{
  removed: number;
  pending: Array<{ path: string; error: string | null }>;
}> {
  const { data: jobs, error } = await supabase
    .from("data_cleanup_jobs")
    .select("id, bucket, object_path")
    .eq("user_id", userId);

  if (error) throw error;

  let removed = 0;
  const pending: Array<{ path: string; error: string | null }> = [];

  for (const job of jobs ?? []) {
    const { error: storageError } = await supabase.storage
      .from(job.bucket)
      .remove([job.object_path]);

    if (storageError) {
      /*
       * Record the failure, then leave the job in place. Deleting the job here
       * would make the deletion look finished while the file still exists —
       * exactly the silent-failure mode this design exists to prevent.
       */
      await supabase.rpc("record_cleanup_failure", {
        p_job_id: job.id,
        p_error: storageError.message,
      });
      pending.push({ path: job.object_path, error: storageError.message });
      continue;
    }

    const { error: deleteError } = await supabase
      .from("data_cleanup_jobs")
      .delete()
      .eq("id", job.id)
      .eq("user_id", userId);

    if (deleteError) {
      // The object is gone but the queue row is not. Harmless, and retryable:
      // removing a missing object succeeds, so the next run clears it.
      pending.push({ path: job.object_path, error: deleteError.message });
      continue;
    }

    removed += 1;
  }

  return { removed, pending };
}

/**
 * Deletes one contact.
 *
 * Safe to call repeatedly. A second call finds no rows, deletes nothing, drains
 * whatever cleanup is outstanding, and reports `complete: true`.
 */
export async function deleteContactData(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<DeletionOutcome> {
  const { data, error } = await supabase.rpc("delete_contact_data", {
    p_contact_id: contactId,
  });

  if (error) {
    /*
     * The transaction rolled back, so nothing was deleted. Say that plainly and
     * do not attempt storage work: there is none queued, because the queue
     * insert was part of the same transaction.
     */
    throw new DeletionError(
      `The deletion did not run, so no records were removed: ${error.message}`,
    );
  }

  const result = parseRpcResult(data);
  if (!result) {
    throw new DeletionError(
      "The database did not confirm what was deleted, so assume nothing was. Please check before retrying.",
    );
  }

  const drained = await drainCleanupQueue(supabase, userId);

  return {
    rowsDeleted: true,
    /*
     * Completeness is decided AFTER draining, not from the database's flag.
     * That flag is computed inside the transaction, before any storage work has
     * been attempted, so it only tells us files were queued — not whether they
     * came out. Trusting it here would report an incomplete deletion as
     * complete, which is the exact failure this design exists to prevent.
     */
    complete: drained.pending.length === 0,
    deleted: result.deleted,
    queuedFiles: result.queued_files,
    filesRemoved: drained.removed,
    pendingCleanup: drained.pending,
    profileAnonymised: false,
  };
}

/**
 * Deletes everything the user owns and anonymises their profile.
 *
 * The profile step is included here because "delete all my data" that leaves the
 * user's name and email behind is not what anyone means by it. The identifying
 * columns are cleared; the auth account itself is not touched. See the header of
 * migration 0011 for exactly what survives and why.
 */
export async function deleteEverything(
  supabase: ServerSupabaseClient,
  userId: string,
  options: { anonymiseProfile?: boolean } = {},
): Promise<DeletionOutcome> {
  const anonymise = options.anonymiseProfile ?? true;

  const { data, error } = await supabase.rpc("delete_all_user_data", {
    p_anonymise: anonymise,
  });

  if (error) {
    throw new DeletionError(
      `The deletion did not run, so no records were removed: ${error.message}`,
    );
  }

  const result = parseRpcResult(data);
  if (!result) {
    throw new DeletionError(
      "The database did not confirm what was deleted, so assume nothing was. Please check before retrying.",
    );
  }

  const drained = await drainCleanupQueue(supabase, userId);

  return {
    rowsDeleted: true,
    // As above: only the draining result can say whether files are really gone.
    complete: drained.pending.length === 0,
    deleted: result.deleted,
    queuedFiles: result.queued_files,
    filesRemoved: drained.removed,
    pendingCleanup: drained.pending,
    profileAnonymised: anonymise,
  };
}

/**
 * Retries outstanding storage removals without deleting any more rows.
 *
 * This is what the UI calls when a previous attempt left files behind, and what
 * makes the workflow retryable rather than a one-shot that can strand data.
 */
export async function retryPendingCleanup(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<Pick<DeletionOutcome, "complete" | "filesRemoved" | "pendingCleanup">> {
  const drained = await drainCleanupQueue(supabase, userId);

  return {
    complete: drained.pending.length === 0,
    filesRemoved: drained.removed,
    pendingCleanup: drained.pending,
  };
}

/** Outstanding cleanup for the settings page, so pending work is visible. */
export async function listPendingCleanup(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<Array<{ path: string; attempts: number; lastError: string | null }>> {
  const { data, error } = await supabase
    .from("data_cleanup_jobs")
    .select("object_path, attempts, last_error")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    path: row.object_path,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}
