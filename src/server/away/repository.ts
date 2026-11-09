/**
 * Away Mode persistence.
 *
 * Every query is scoped by `user_id` in addition to relying on RLS. RLS is the
 * guarantee; the explicit filter means a mistake in a policy cannot silently
 * widen a query, and it matches the pattern used by the rest of the server code.
 */

import "server-only";

import type { Json, TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type {
  AwayContactPermissionRow,
  AwayEventKind,
  AwayEventRow,
  AwayPermission,
  AwayPreparedReplyRow,
  AwaySettingsRow,
  AwayStatus,
} from "@/lib/supabase/database.types";

/** Row created on first read, so a user always has settings to look at. */
export async function getAwaySettings(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<AwaySettingsRow> {
  const { data, error } = await supabase
    .from("away_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: createError } = await supabase
    .from("away_settings")
    .insert({ user_id: userId } satisfies TablesInsert<"away_settings">)
    .select("*")
    .single();

  if (createError) throw createError;
  return created;
}

export type UpdateAwaySettingsInput = {
  status: AwayStatus;
  startsAt: string | null;
  endsAt: string | null;
  awayMessage: string | null;
  defaultPermission: AwayPermission;
};

export async function updateAwaySettings(
  supabase: ServerSupabaseClient,
  userId: string,
  input: UpdateAwaySettingsInput,
): Promise<AwaySettingsRow> {
  const patch: TablesUpdate<"away_settings"> = {
    status: input.status,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    away_message: input.awayMessage,
    default_permission: input.defaultPermission,
  };

  const { data, error } = await supabase
    .from("away_settings")
    .update(patch)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/** All per-contact overrides, keyed by contact for cheap lookup. */
export async function listContactPermissions(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<Map<string, AwayContactPermissionRow>> {
  const { data, error } = await supabase
    .from("away_contact_permissions")
    .select("*")
    .eq("user_id", userId);

  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.contact_id, row]));
}

export async function getContactPermission(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<AwayContactPermissionRow | null> {
  const { data, error } = await supabase
    .from("away_contact_permissions")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/** Upsert so the UI can toggle a contact without a separate create step. */
export async function setContactPermission(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  permission: AwayPermission,
): Promise<AwayContactPermissionRow> {
  const { data, error } = await supabase
    .from("away_contact_permissions")
    .upsert(
      { user_id: userId, contact_id: contactId, permission } satisfies TablesInsert<"away_contact_permissions">,
      { onConflict: "user_id,contact_id" },
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function clearContactPermission(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<void> {
  const { error } = await supabase
    .from("away_contact_permissions")
    .delete()
    .eq("user_id", userId)
    .eq("contact_id", contactId);

  if (error) throw error;
}

/** Prepared replies awaiting a decision. Nothing here has been sent. */
export async function listPendingReplies(
  supabase: ServerSupabaseClient,
  userId: string,
  limit = 50,
): Promise<AwayPreparedReplyRow[]> {
  const { data, error } = await supabase
    .from("away_prepared_replies")
    .select("*")
    .eq("user_id", userId)
    .eq("state", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function getPreparedReply(
  supabase: ServerSupabaseClient,
  userId: string,
  replyId: string,
): Promise<AwayPreparedReplyRow | null> {
  const { data, error } = await supabase
    .from("away_prepared_replies")
    .select("*")
    .eq("user_id", userId)
    .eq("id", replyId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export type NewPreparedReply = {
  userId: string;
  contactId: string;
  inReplyToMessageId: string | null;
  body: string;
  modelProvider: string | null;
  modelName: string | null;
  promptVersion: string | null;
};

export async function createPreparedReply(
  supabase: ServerSupabaseClient,
  input: NewPreparedReply,
): Promise<AwayPreparedReplyRow> {
  const { data, error } = await supabase
    .from("away_prepared_replies")
    .insert({
      user_id: input.userId,
      contact_id: input.contactId,
      in_reply_to_message_id: input.inReplyToMessageId,
      body: input.body,
      // Never set state here: the schema default 'pending' is the gate.
      model_provider: input.modelProvider,
      model_name: input.modelName,
      prompt_version: input.promptVersion,
    } satisfies TablesInsert<"away_prepared_replies">)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Records the user's decision.
 *
 * Only a `pending` row can move: a second approval of the same reply is a bug,
 * not a no-op, because it would double-count in the activity history.
 */
export async function decidePreparedReply(
  supabase: ServerSupabaseClient,
  userId: string,
  replyId: string,
  decision: "approved" | "rejected",
): Promise<AwayPreparedReplyRow> {
  const { data, error } = await supabase
    .from("away_prepared_replies")
    .update({ state: decision, decided_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", replyId)
    .eq("state", "pending")
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error("That prepared reply is no longer waiting for a decision.");
  }
  return data;
}

/** Append-only activity log. There is no update or delete path by design. */
export async function recordAwayEvent(
  supabase: ServerSupabaseClient,
  params: {
    userId: string;
    contactId?: string | null;
    kind: AwayEventKind;
    detail?: string | null;
    data?: Json | null;
  },
): Promise<void> {
  const { error } = await supabase.from("away_events").insert({
    user_id: params.userId,
    contact_id: params.contactId ?? null,
    kind: params.kind,
    detail: params.detail ?? null,
    data: params.data ?? null,
  } satisfies TablesInsert<"away_events">);

  if (error) throw error;
}

export async function listAwayEvents(
  supabase: ServerSupabaseClient,
  userId: string,
  limit = 50,
): Promise<AwayEventRow[]> {
  const { data, error } = await supabase
    .from("away_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
