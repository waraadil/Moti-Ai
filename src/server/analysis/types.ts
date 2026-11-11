/**
 * Database-facing types for the analysis layer.
 *
 * Kept next to the repository so the intelligence services stay free of
 * Supabase row shapes.
 */

export type AnalysisKind =
  | "communication_profile"
  | "relationship_context"
  | "memory_extraction"
  | "reply_suggestion"
  | "temporal_diff";

export type MemoryCandidateRow = {
  statement: string;
  category:
    "preference" | "life_event" | "relationship" | "boundary" | "goal" | "routine" | "sensitive";
  topics: string[];
  details: string | null;
  confidence: number;
  isSensitive: boolean;
  /** sha256 of the normalised statement; prevents duplicate memories. */
  fingerprint: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
};

export type AnalysisVersionRow = {
  id: string;
  version: number;
  kind: AnalysisKind;
  status: string;
};

/** Loose row type for the extra tables added in migration 0008. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type TablesInsert<T extends string> = T extends "analysis_versions"
  ? {
      user_id: string;
      contact_id: string;
      kind: AnalysisKind;
      status: string;
      version: number;
      message_count: number;
      source_from: string | null;
      source_until: string | null;
      model_provider: string;
      model_name: string;
      prompt_version: string;
      output: Json;
      completed_at: string;
    }
  : T extends "conversation_snapshots"
    ? {
        user_id: string;
        contact_id: string;
        analysis_version_id: string | null;
        cutoff_at: string;
        message_count: number;
        data: Json;
      }
    : never;
