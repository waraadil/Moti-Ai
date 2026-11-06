/**
 * Hand-maintained types for the Moti AI schema.
 *
 * These mirror `supabase/migrations` exactly and are the single source of truth
 * for query result shapes. Regenerate with the Supabase CLI once a project is
 * linked:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public \
 *     > src/lib/supabase/database.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type RelationshipKind =
  "family" | "friend" | "partner" | "colleague" | "acquaintance" | "client" | "other" | "unknown";

export type ChatImportSource = "whatsapp_txt_export" | "whatsapp_zip_export";

export type ChatImportStatus = "uploaded" | "parsing" | "needs_review" | "completed" | "failed";

export type MessageDirection = "outgoing" | "incoming" | "system" | "unknown";

export type MessageKind = "text" | "media" | "missed_call" | "deleted" | "system";

export type ParticipantScope = "self" | "contact";

export type AnalysisKind =
  "communication_profile" | "relationship_context" | "memory_extraction" | "reply_suggestion";

export type AnalysisStatus = "pending" | "running" | "completed" | "failed" | "superseded";

export type MemoryCategory =
  "preference" | "life_event" | "relationship" | "boundary" | "goal" | "routine" | "sensitive";

export type MemoryStatus = "active" | "superseded" | "archived";

export type ReplyDraftStatus = "draft" | "accepted" | "edited" | "discarded";

export type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  timezone: string;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ContactRow = {
  id: string;
  user_id: string;
  display_name: string;
  relationship_kind: RelationshipKind;
  whatsapp_jid: string | null;
  phone_number: string | null;
  notes: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};

export type ContactAliasRow = {
  id: string;
  user_id: string;
  contact_id: string;
  alias: string;
  source: string;
  is_confirmed: boolean;
  created_at: string;
};

export type ChatImportRow = {
  id: string;
  user_id: string;
  contact_id: string | null;
  source: ChatImportSource;
  status: ChatImportStatus;
  storage_path: string;
  original_filename: string;
  byte_size: number;
  checksum: string | null;
  total_lines: number;
  parsed_messages: number;
  skipped_lines: number;
  detected_participants: string[];
  error_message: string | null;
  parse_warnings: Json;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  user_id: string;
  chat_import_id: string;
  contact_id: string;
  direction: MessageDirection;
  kind: MessageKind;
  sender_label: string | null;
  sent_at: string | null;
  body: string | null;
  raw_line: string | null;
  line_number: number | null;
  media_filename: string | null;
  is_forwarded: boolean;
  source_fingerprint: string;
  created_at: string;
};

export type CommunicationProfileRow = {
  id: string;
  user_id: string;
  contact_id: string;
  analysis_version_id: string | null;
  participant: ParticipantScope;
  message_count: number;
  median_message_chars: number | null;
  median_response_minutes: number | null;
  initiates_conversations_pct: number | null;
  formality: number | null;
  warmth: number | null;
  humour: number | null;
  directness: number | null;
  emoji_rate: number | null;
  summary: string | null;
  sample_topics: string[];
  common_phrases: string[];
  is_populated: boolean;
  created_at: string;
  updated_at: string;
};

export type RelationshipContextRow = {
  id: string;
  user_id: string;
  contact_id: string;
  analysis_version_id: string | null;
  relationship_kind: RelationshipKind;
  origin_summary: string | null;
  dynamics_summary: string | null;
  open_threads: string[];
  sensitivities: string[];
  confidence: number;
  is_user_edited: boolean;
  is_populated: boolean;
  created_at: string;
  updated_at: string;
};

export type MemoryRow = {
  id: string;
  user_id: string;
  contact_id: string;
  analysis_version_id: string | null;
  category: MemoryCategory;
  status: MemoryStatus;
  statement: string;
  details: string | null;
  topics: string[];
  confidence: number;
  is_user_confirmed: boolean;
  is_sensitive: boolean;
  first_observed_at: string | null;
  last_observed_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryEvidenceRow = {
  id: string;
  user_id: string;
  memory_id: string;
  message_id: string | null;
  excerpt: string | null;
  rationale: string | null;
  confidence: number;
  created_at: string;
};

export type AnalysisVersionRow = {
  id: string;
  user_id: string;
  contact_id: string;
  kind: AnalysisKind;
  status: AnalysisStatus;
  version: number;
  source_from: string | null;
  source_until: string | null;
  message_count: number;
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  output: Json | null;
  error_message: string | null;
  superseded_by: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ReplyDraftRow = {
  id: string;
  user_id: string;
  contact_id: string;
  analysis_version_id: string | null;
  in_reply_to_message_id: string | null;
  status: ReplyDraftStatus;
  tone: string | null;
  body: string;
  used_memory_ids: string[];
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  accepted_at: string | null;
  edited_body: string | null;
  created_at: string;
  updated_at: string;
};

type TableDefinition<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableDefinition<ProfileRow>;
      contacts: TableDefinition<ContactRow>;
      contact_aliases: TableDefinition<ContactAliasRow>;
      chat_imports: TableDefinition<ChatImportRow>;
      messages: TableDefinition<MessageRow>;
      communication_profiles: TableDefinition<CommunicationProfileRow>;
      relationship_contexts: TableDefinition<RelationshipContextRow>;
      memories: TableDefinition<MemoryRow>;
      memory_evidence: TableDefinition<MemoryEvidenceRow>;
      analysis_versions: TableDefinition<AnalysisVersionRow>;
      reply_drafts: TableDefinition<ReplyDraftRow>;
    };
    Views: Record<string, never>;
    Functions: {
      current_user_id: { Args: Record<string, never>; Returns: string };
    };
    Enums: {
      relationship_kind: RelationshipKind;
      chat_import_source: ChatImportSource;
      chat_import_status: ChatImportStatus;
      message_direction: MessageDirection;
      message_kind: MessageKind;
      participant_scope: ParticipantScope;
      analysis_kind: AnalysisKind;
      analysis_status: AnalysisStatus;
      memory_category: MemoryCategory;
      memory_status: MemoryStatus;
      reply_draft_status: ReplyDraftStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
