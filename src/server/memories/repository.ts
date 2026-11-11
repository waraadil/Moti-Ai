/**
 * Memory and evidence data access.
 *
 * Memories are never overwritten in place. Correcting a memory means:
 *   1. insert the replacement,
 *   2. mark the old row `status = 'superseded'` with `superseded_by` set.
 * The schema enforces step 2's link, so history cannot be lost.
 */

import "server-only";

import { NotFoundError } from "@/lib/errors";
import type {
  MemoryCategory,
  MemoryEvidenceRow,
  MemoryRow,
  MemoryStatus,
} from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type MemoryWithEvidence = MemoryRow & {
  evidence: MemoryEvidenceRow[];
};

/** Shared implementation: the repository must agree with the pipeline exactly. */
import { memoryFingerprint } from "@/lib/intelligence/fingerprint";

export const fingerprintStatement = memoryFingerprint;

/** Raised when a memory write would collide with an existing active fact. */
export class DuplicateMemoryError extends Error {
  constructor(public readonly existingMemoryId: string) {
    super("An active memory already states this. Correct or archive that one instead.");
    this.name = "DuplicateMemoryError";
  }
}

export async function listMemories(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  options: { status?: MemoryStatus; category?: MemoryCategory; limit?: number } = {},
): Promise<MemoryRow[]> {
  let query = supabase
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("status", options.status ?? "active")
    .order("confidence", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 100);

  if (options.category) query = query.eq("category", options.category);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Loads memories plus their supporting messages in two queries, not N+1. */
export async function listMemoriesWithEvidence(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  options: { limit?: number } = {},
): Promise<MemoryWithEvidence[]> {
  const memories = await listMemories(supabase, userId, contactId, {
    status: "active",
    limit: options.limit,
  });

  if (memories.length === 0) return [];

  const { data: evidence, error } = await supabase
    .from("memory_evidence")
    .select("*")
    .eq("user_id", userId)
    .in(
      "memory_id",
      memories.map((memory) => memory.id),
    );

  if (error) throw error;

  const byMemory = new Map<string, MemoryEvidenceRow[]>();
  for (const row of evidence ?? []) {
    const existing = byMemory.get(row.memory_id) ?? [];
    existing.push(row);
    byMemory.set(row.memory_id, existing);
  }

  return memories.map((memory) => ({
    ...memory,
    evidence: byMemory.get(memory.id) ?? [],
  }));
}

export async function createMemory(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  input: {
    category: MemoryCategory;
    statement: string;
    details?: string;
    topics?: string[];
    confidence?: number;
    isSensitive?: boolean;
  },
): Promise<MemoryRow> {
  const { data, error } = await supabase
    .from("memories")
    .insert({
      user_id: userId,
      contact_id: contactId,
      category: input.category,
      statement: input.statement,
      details: input.details ?? null,
      topics: input.topics ?? [],
      confidence: input.confidence ?? 0,
      is_sensitive: input.isSensitive ?? false,
      fingerprint: fingerprintStatement(input.statement),
      // A memory the user typed in themselves is, by definition, confirmed.
      is_user_confirmed: true,
    })
    .select("*")
    .single();

  if (error)
    throw await translateFingerprintClash(supabase, userId, contactId, input.statement, error);
  return data;
}

/**
 * Replaces a memory with a corrected version and supersedes the original.
 * The original row stays in the database with a pointer to its replacement.
 */
export async function supersedeMemory(
  supabase: ServerSupabaseClient,
  userId: string,
  memoryId: string,
  input: {
    category: MemoryCategory;
    statement: string;
    details?: string;
    topics?: string[];
    isSensitive?: boolean;
  },
): Promise<MemoryRow> {
  const { data: original, error: readError } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .eq("id", memoryId)
    .maybeSingle();

  if (readError) throw readError;
  if (!original) throw new NotFoundError("That memory does not exist or is not yours.");

  if (original.status === "superseded") {
    throw new NotFoundError("That memory has already been replaced.");
  }

  const { data: replacement, error: insertError } = await supabase
    .from("memories")
    .insert({
      user_id: userId,
      contact_id: original.contact_id,
      analysis_version_id: original.analysis_version_id,
      category: input.category,
      statement: input.statement,
      details: input.details ?? original.details,
      topics: input.topics ?? original.topics,
      confidence: original.confidence,
      is_sensitive: input.isSensitive ?? original.is_sensitive,
      fingerprint: fingerprintStatement(input.statement),
      is_user_confirmed: true,
      first_observed_at: original.first_observed_at,
      last_observed_at: original.last_observed_at,
    })
    .select("*")
    .single();

  if (insertError) {
    throw await translateFingerprintClash(
      supabase,
      userId,
      original.contact_id,
      input.statement,
      insertError,
    );
  }

  const { error: updateError } = await supabase
    .from("memories")
    .update({ status: "superseded", superseded_by: replacement.id })
    .eq("user_id", userId)
    .eq("id", memoryId);

  if (updateError) {
    // Roll back the replacement so the pair is never left inconsistent.
    await supabase.from("memories").delete().eq("user_id", userId).eq("id", replacement.id);
    throw updateError;
  }

  return replacement;
}

/** Archives a memory without deleting it or its evidence. */
export async function archiveMemory(
  supabase: ServerSupabaseClient,
  userId: string,
  memoryId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("memories")
    .update({ status: "archived" })
    .eq("user_id", userId)
    .eq("id", memoryId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("That memory does not exist, is not yours, or is not active.");
}

/**
 * Turns a unique-violation on `memories_active_fingerprint_key` into a message a
 * person can act on, and returns every other error untouched.
 */
async function translateFingerprintClash(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  statement: string,
  error: { code?: string; message?: string },
): Promise<unknown> {
  const isUniqueViolation =
    error.code === "23505" || (error.message ?? "").toLowerCase().includes("duplicate key");

  if (!isUniqueViolation) return error;

  const { data } = await supabase
    .from("memories")
    .select("id")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .eq("fingerprint", fingerprintStatement(statement))
    .maybeSingle();

  return new DuplicateMemoryError(data?.id ?? "");
}
