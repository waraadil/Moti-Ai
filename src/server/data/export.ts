/**
 * User data export.
 *
 * Produces a complete JSON snapshot of everything Moti AI stores for one user.
 * The point is that a user can leave, or check what is held about them, without
 * asking anyone: the export is built from their own session, not a service role.
 *
 * Deliberately excluded: API keys, environment values, and anything belonging to
 * another user. Stored upload files are listed by name, not embedded — the
 * bytes are already in the export the user gave us, and inlining megabytes of
 * chat text into JSON would make the download fail rather than help.
 */

import "server-only";

import type { ServerSupabaseClient } from "@/lib/supabase/server";

export type ExportCounts = {
  contacts: number;
  messages: number;
  imports: number;
  memories: number;
  analysisVersions: number;
  replyDrafts: number;
  awayPreparedReplies: number;
};

export type UserExport = {
  meta: {
    format: "moti-ai-export";
    version: 1;
    generatedAt: string;
    /** Stated plainly so nobody mistakes this for a messaging archive. */
    note: string;
  };
  profile: Record<string, unknown> | null;
  counts: ExportCounts;
  contacts: unknown[];
  chatImports: unknown[];
  messages: unknown[];
  communicationProfiles: unknown[];
  relationshipContexts: unknown[];
  memories: unknown[];
  memoryEvidence: unknown[];
  analysisVersions: unknown[];
  analysisRuns: unknown[];
  conversationSnapshots: unknown[];
  replyDrafts: unknown[];
  awaySettings: unknown[];
  awayContactPermissions: unknown[];
  awayPreparedReplies: unknown[];
  awayEvents: unknown[];
};

/** Tables that hold user data, in the order they should appear in the export. */
const EXPORT_TABLES = [
  "contacts",
  "chat_imports",
  "messages",
  "communication_profiles",
  "relationship_contexts",
  "memories",
  "memory_evidence",
  "analysis_versions",
  "analysis_runs",
  "conversation_snapshots",
  "reply_drafts",
  "away_settings",
  "away_contact_permissions",
  "away_prepared_replies",
  "away_events",
] as const;

type ExportTable = (typeof EXPORT_TABLES)[number];

/** PostgREST caps a single response; page rather than silently truncating. */
const PAGE_SIZE = 1000;

/**
 * Reads every row for the user from one table.
 *
 * If the page limit is ever reached the export keeps paging until a short page
 * arrives, so a large account cannot receive a silently truncated file.
 */
async function readAll(
  supabase: ServerSupabaseClient,
  userId: string,
  table: ExportTable,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("user_id", userId)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;

    const page = data ?? [];
    rows.push(...page);

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

/** Builds the full export. Every table is read, even when it is empty. */
export async function buildUserExport(
  supabase: ServerSupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<UserExport> {
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) throw profileError;

  const collected = new Map<ExportTable, unknown[]>();
  for (const table of EXPORT_TABLES) {
    collected.set(table, await readAll(supabase, userId, table));
  }

  const get = (table: ExportTable) => collected.get(table) ?? [];

  const messages = get("messages");
  const memories = get("memories");

  const counts: ExportCounts = {
    contacts: get("contacts").length,
    messages: messages.length,
    imports: get("chat_imports").length,
    memories: memories.length,
    analysisVersions: get("analysis_versions").length,
    replyDrafts: get("reply_drafts").length,
    awayPreparedReplies: get("away_prepared_replies").length,
  };

  return {
    meta: {
      format: "moti-ai-export",
      version: 1,
      generatedAt: now.toISOString(),
      note: "This is everything Moti AI stores for your account. It contains no passwords, no API keys, and no data belonging to another user. Moti AI never sends messages, so there is no sent-message history here.",
    },
    profile: profile ?? null,
    counts,
    contacts: get("contacts"),
    chatImports: get("chat_imports"),
    messages,
    communicationProfiles: get("communication_profiles"),
    relationshipContexts: get("relationship_contexts"),
    memories,
    memoryEvidence: get("memory_evidence"),
    analysisVersions: get("analysis_versions"),
    analysisRuns: get("analysis_runs"),
    conversationSnapshots: get("conversation_snapshots"),
    replyDrafts: get("reply_drafts"),
    awaySettings: get("away_settings"),
    awayContactPermissions: get("away_contact_permissions"),
    awayPreparedReplies: get("away_prepared_replies"),
    awayEvents: get("away_events"),
  };
}

/** A stable filename, so repeated downloads do not accumulate. */
export function exportFilename(now: Date = new Date()): string {
  return `moti-ai-export-${now.toISOString().slice(0, 10)}.json`;
}
