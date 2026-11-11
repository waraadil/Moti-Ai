/**
 * Analysis data access.
 *
 * Two responsibilities kept apart from the pure services:
 *   - idempotent run bookkeeping (`analysis_runs`),
 *   - writing versioned output (`analysis_versions` + child tables).
 *
 * Every write is scoped by user_id, and nothing here updates historical rows:
 * a new run creates a new version and supersedes the previous one.
 */

import "server-only";

import { createHash } from "node:crypto";
import type { AnalysisKind, AnalysisVersionRow, MemoryCandidateRow, TablesInsert } from "./types";
import type { AnalysisVersionRow as StoredAnalysisVersion } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type RunKey = {
  userId: string;
  contactId: string;
  kind: AnalysisKind;
  inputHash: string;
  /**
   * Messages in this analysis window. When a later import covers more history,
   * the existing run row is extended rather than duplicated, so the run records
   * everything that has been analysed for this contact.
   */
  inputMessages: number;
};

export function hashAnalysisInput(parts: {
  promptVersion: string;
  messageIds: readonly string[];
  bodies: readonly string[];
}): string {
  const hash = createHash("sha256");
  hash.update(`prompt:${parts.promptVersion}\n`);
  for (const id of parts.messageIds) hash.update(`id:${id}\n`);
  for (const body of parts.bodies) hash.update(`body:${body}\n`);
  return hash.digest("hex").slice(0, 64).padEnd(64, "0");
}

export type RunRecord = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "superseded";
  analysisVersionId: string | null;
  attempts: number;
};

/**
 * Finds or creates the run row for this exact input.
 * Because `analysis_runs_unique_input` is unique on (contact, kind, hash), two
 * concurrent attempts cannot both create a run.
 */
export async function beginRun(
  supabase: ServerSupabaseClient,
  key: RunKey,
): Promise<{ run: RunRecord; alreadyCompleted: boolean }> {
  const { data: existing, error: readError } = await supabase
    .from("analysis_runs")
    .select("id, status, analysis_version_id, attempts, input_messages")
    .eq("user_id", key.userId)
    .eq("contact_id", key.contactId)
    .eq("kind", key.kind)
    .eq("input_hash", key.inputHash)
    .maybeSingle();

  if (readError) throw readError;

  if (existing) {
    if (existing.status === "completed" && existing.analysis_version_id) {
      return {
        run: {
          id: existing.id,
          status: "completed",
          analysisVersionId: existing.analysis_version_id,
          attempts: existing.attempts,
        },
        alreadyCompleted: true,
      };
    }

    // Retry: bump the attempt counter and reset the error.
    const { data: retried, error: retryError } = await supabase
      .from("analysis_runs")
      .update({
        status: "running",
        attempts: existing.attempts + 1,
        input_messages: Math.max(existing.input_messages ?? 0, key.inputMessages),
        error_message: null,
      })
      .eq("user_id", key.userId)
      .eq("id", existing.id)
      .select("id, status, analysis_version_id, attempts, input_messages")
      .single();

    if (retryError) throw retryError;

    return {
      run: {
        id: retried.id,
        status: retried.status,
        analysisVersionId: retried.analysis_version_id,
        attempts: retried.attempts,
      },
      alreadyCompleted: false,
    };
  }

  const { data: created, error: insertError } = await supabase
    .from("analysis_runs")
    .insert({
      user_id: key.userId,
      contact_id: key.contactId,
      kind: key.kind,
      input_hash: key.inputHash,
      input_messages: key.inputMessages,
      status: "running",
      attempts: 1,
    })
    .select("id, status, analysis_version_id, attempts, input_messages")
    .single();

  if (insertError) {
    // Lost a race: another worker created the row. Re-read it.
    if (insertError.code === "23505") {
      const { data: raced } = await supabase
        .from("analysis_runs")
        .select("id, status, analysis_version_id, attempts, input_messages")
        .eq("user_id", key.userId)
        .eq("contact_id", key.contactId)
        .eq("kind", key.kind)
        .eq("input_hash", key.inputHash)
        .maybeSingle();

      if (raced) {
        return {
          run: {
            id: raced.id,
            status: raced.status,
            analysisVersionId: raced.analysis_version_id,
            attempts: raced.attempts,
          },
          alreadyCompleted: false,
        };
      }
    }
    throw insertError;
  }

  return {
    run: {
      id: created.id,
      status: created.status,
      analysisVersionId: created.analysis_version_id,
      attempts: created.attempts,
    },
    alreadyCompleted: false,
  };
}

/** Next version number for this (contact, kind). Never reuses a number. */
export async function nextVersionNumber(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  kind: AnalysisKind,
): Promise<number> {
  const { data, error } = await supabase
    .from("analysis_versions")
    .select("version")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("kind", kind)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data?.version ?? 0) + 1;
}

export type CreateVersionParams = {
  userId: string;
  contactId: string;
  kind: AnalysisKind;
  version: number;
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  messageCount: number;
  sourceFrom: string | null;
  sourceUntil: string | null;
  output: unknown;
  /** Changes vs the previous snapshot. Null/omitted on a first run. */
  temporalDiff?: unknown;
};

export async function createVersion(
  supabase: ServerSupabaseClient,
  params: CreateVersionParams,
): Promise<AnalysisVersionRow> {
  const { data, error } = await supabase
    .from("analysis_versions")
    .insert({
      user_id: params.userId,
      contact_id: params.contactId,
      kind: params.kind,
      status: "completed",
      version: params.version,
      message_count: params.messageCount,
      source_from: params.sourceFrom,
      source_until: params.sourceUntil,
      model_provider: params.modelProvider,
      model_name: params.modelName,
      prompt_version: params.promptVersion,
      output: params.output as TablesInsert<"analysis_versions">["output"],
      temporal_diff: (params.temporalDiff ?? null) as TablesInsert<"analysis_versions">["output"],
      completed_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/** Points the previous version at its successor, preserving history. */
export async function supersedePreviousVersions(
  supabase: ServerSupabaseClient,
  params: {
    userId: string;
    contactId: string;
    kind: AnalysisKind;
    newVersionId: string;
    newVersion: number;
  },
): Promise<void> {
  const { error } = await supabase
    .from("analysis_versions")
    .update({ status: "superseded", superseded_by: params.newVersionId })
    .eq("user_id", params.userId)
    .eq("contact_id", params.contactId)
    .eq("kind", params.kind)
    .eq("status", "completed")
    .lt("version", params.newVersion)
    .is("superseded_by", null);

  if (error) throw error;
}

export async function completeRun(
  supabase: ServerSupabaseClient,
  params: { userId: string; runId: string; versionId: string; durationMs: number },
): Promise<void> {
  const { error } = await supabase
    .from("analysis_runs")
    .update({
      status: "completed",
      analysis_version_id: params.versionId,
      duration_ms: params.durationMs,
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("id", params.runId);

  if (error) throw error;
}

export async function failRun(
  supabase: ServerSupabaseClient,
  params: { userId: string; runId: string; errorMessage: string; durationMs: number },
): Promise<void> {
  const { error } = await supabase
    .from("analysis_runs")
    .update({
      status: "failed",
      error_message: params.errorMessage.slice(0, 2000),
      duration_ms: params.durationMs,
    })
    .eq("user_id", params.userId)
    .eq("id", params.runId);

  if (error) throw error;
}

export async function findCompletedRun(
  supabase: ServerSupabaseClient,
  key: RunKey,
): Promise<{ versionId: string } | null> {
  const { data, error } = await supabase
    .from("analysis_runs")
    .select("analysis_version_id, status")
    .eq("user_id", key.userId)
    .eq("contact_id", key.contactId)
    .eq("kind", key.kind)
    .eq("input_hash", key.inputHash)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.status !== "completed" || !data.analysis_version_id) return null;
  return { versionId: data.analysis_version_id };
}

/**
 * The most recent temporal changes recorded for a contact.
 *
 * A diff is computed during a run and stored on that run's version output, so
 * the UI can show "what changed since last time" without recomputing it.
 * Returns the newest version that actually recorded changes.
 */
export async function recentTemporalChanges(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  limit = 5,
): Promise<{ version: number; changes: unknown[]; completedAt: string | null } | null> {
  const { data, error } = await supabase
    .from("analysis_versions")
    .select("version, completed_at, temporal_diff")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("status", "completed")
    .not("temporal_diff", "is", null)
    .order("version", { ascending: false })
    .limit(limit);

  if (error) throw error;

  for (const row of data ?? []) {
    const changes = row.temporal_diff as unknown;
    if (Array.isArray(changes) && changes.length > 0) {
      return {
        version: row.version,
        changes,
        completedAt: row.completed_at ?? null,
      };
    }
  }

  return null;
}

/** The newest non-superseded version for a contact and analysis kind. */
export async function latestVersion(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  kind: AnalysisKind,
): Promise<StoredAnalysisVersion | null> {
  const { data, error } = await supabase
    .from("analysis_versions")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .eq("kind", kind)
    .eq("status", "completed")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Communication profiles
// ---------------------------------------------------------------------------

export async function upsertCommunicationProfile(
  supabase: ServerSupabaseClient,
  row: {
    userId: string;
    contactId: string;
    analysisVersionId: string;
    participant: "self" | "contact";
    messageCount: number;
    medianChars: number;
    medianReplyMinutes: number | null;
    formality: number | null;
    warmth: number | null;
    humour: number | null;
    directness: number | null;
    emojiRate: number;
    summary: string;
    sampleTopics: string[];
    commonPhrases: string[];
    isPopulated: boolean;
  },
): Promise<void> {
  const { error } = await supabase.from("communication_profiles").upsert(
    {
      user_id: row.userId,
      contact_id: row.contactId,
      analysis_version_id: row.analysisVersionId,
      participant: row.participant,
      message_count: row.messageCount,
      median_message_chars: row.medianChars,
      median_response_minutes: row.medianReplyMinutes,
      formality: row.formality,
      warmth: row.warmth,
      humour: row.humour,
      directness: row.directness,
      emoji_rate: row.emojiRate,
      summary: row.summary,
      sample_topics: row.sampleTopics,
      common_phrases: row.commonPhrases,
      is_populated: row.isPopulated,
    },
    { onConflict: "contact_id,participant" },
  );

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Memories + evidence
// ---------------------------------------------------------------------------

export type MemoryInsert = {
  candidate: MemoryCandidateRow;
  analysisVersionId: string;
  contactId: string;
  userId: string;
  evidence: Array<{
    messageId: string | null;
    excerpt: string | null;
    rationale: string | null;
    confidence: number;
    evidenceStatus: "direct" | "inferred" | "user_asserted";
    speakerLabel: string | null;
    saidAt: string | null;
  }>;
};

export type MemoryWriteResult = {
  inserted: number;
  duplicated: number;
  /** Memories whose fingerprint already existed and were left untouched. */
  skippedFingerprints: string[];
};

/**
 * Inserts memories, skipping any whose fingerprint is already active.
 *
 * The pre-check plus the unique partial index means a retried run cannot create
 * a duplicate even if two workers overlap.
 */
export async function insertMemories(
  supabase: ServerSupabaseClient,
  rows: readonly MemoryInsert[],
): Promise<MemoryWriteResult> {
  if (rows.length === 0) return { inserted: 0, duplicated: 0, skippedFingerprints: [] };

  const fingerprints = rows.map((row) => row.candidate.fingerprint);

  const { data: existing, error: readError } = await supabase
    .from("memories")
    .select("fingerprint")
    .eq("user_id", rows[0]!.userId)
    .eq("contact_id", rows[0]!.contactId)
    .eq("status", "active")
    .in("fingerprint", fingerprints);

  if (readError) throw readError;

  const taken = new Set((existing ?? []).map((row) => row.fingerprint));
  const fresh = rows.filter((row) => !taken.has(row.candidate.fingerprint));

  if (fresh.length === 0) {
    return {
      inserted: 0,
      duplicated: rows.length,
      skippedFingerprints: [...taken] as string[],
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("memories")
    .insert(
      fresh.map((row) => ({
        user_id: row.userId,
        contact_id: row.contactId,
        analysis_version_id: row.analysisVersionId,
        category: row.candidate.category,
        statement: row.candidate.statement,
        details: row.candidate.details,
        topics: row.candidate.topics,
        confidence: row.candidate.confidence,
        is_sensitive: row.candidate.isSensitive,
        fingerprint: row.candidate.fingerprint,
        first_observed_at: row.candidate.firstObservedAt,
        last_observed_at: row.candidate.lastObservedAt,
        status: "active" as const,
      })),
    )
    .select("id, fingerprint");

  if (insertError) throw insertError;

  const idByFingerprint = new Map((inserted ?? []).map((row) => [row.fingerprint, row.id]));

  const evidenceRows = fresh.flatMap((row) => {
    const memoryId = idByFingerprint.get(row.candidate.fingerprint);
    if (!memoryId) return [];

    return row.evidence.map((evidence) => ({
      user_id: row.userId,
      memory_id: memoryId,
      message_id: evidence.messageId,
      excerpt: evidence.excerpt,
      rationale: evidence.rationale,
      confidence: evidence.confidence,
      evidence_status: evidence.evidenceStatus,
      speaker_label: evidence.speakerLabel,
      said_at: evidence.saidAt,
    }));
  });

  if (evidenceRows.length > 0) {
    const { error: evidenceError } = await supabase.from("memory_evidence").insert(evidenceRows);
    if (evidenceError) throw evidenceError;
  }

  return {
    inserted: fresh.length,
    duplicated: rows.length - fresh.length,
    skippedFingerprints: [...taken] as string[],
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function saveSnapshot(
  supabase: ServerSupabaseClient,
  params: {
    userId: string;
    contactId: string;
    analysisVersionId: string | null;
    cutoffAt: string;
    messageCount: number;
    data: unknown;
  },
): Promise<void> {
  const { error } = await supabase.from("conversation_snapshots").insert({
    user_id: params.userId,
    contact_id: params.contactId,
    analysis_version_id: params.analysisVersionId,
    cutoff_at: params.cutoffAt,
    message_count: params.messageCount,
    data: params.data as TablesInsert<"conversation_snapshots">["data"],
  });

  if (error) throw error;
}

export async function latestSnapshot(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<{ cutoffAt: string; data: unknown } | null> {
  const { data, error } = await supabase
    .from("conversation_snapshots")
    .select("cutoff_at, data")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .order("cutoff_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { cutoffAt: data.cutoff_at, data: data.data };
}
