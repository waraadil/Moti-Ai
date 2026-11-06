/**
 * Message data access for the conversation view.
 *
 * Messages are read-only by design (the database rejects updates), so this
 * module intentionally exposes no write path.
 */

import "server-only";

import type { MessageRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { MessageQuery } from "@/lib/validation/schemas";

export type MessagePage = {
  messages: MessageRow[];
  /** True when another page exists (fetch limit + 1). */
  hasMore: boolean;
};

/**
 * Newest-first page of messages for a contact, optionally filtered by text.
 * Reverses the page before returning so the UI can render chronologically.
 */
export async function listMessages(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  query: MessageQuery,
): Promise<MessagePage> {
  let request = supabase
    .from("messages")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .range(query.offset, query.offset + query.limit);

  if (query.before) request = request.lt("sent_at", query.before);
  if (query.q) request = request.ilike("body", `%${escapeLikePattern(query.q)}%`);

  const { data, error } = await request;
  if (error) throw error;

  const rows = data ?? [];
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return { messages: [...page].reverse(), hasMore };
}

export type ConversationStats = {
  totalMessages: number;
  incoming: number;
  outgoing: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
};

/** Aggregate counts for a contact's conversation. */
export async function getConversationStats(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<ConversationStats> {
  const base = () =>
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("contact_id", contactId);

  const [total, incoming, outgoing, first, last] = await Promise.all([
    base(),
    base().eq("direction", "incoming"),
    base().eq("direction", "outgoing"),
    supabase
      .from("messages")
      .select("sent_at")
      .eq("user_id", userId)
      .eq("contact_id", contactId)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("messages")
      .select("sent_at")
      .eq("user_id", userId)
      .eq("contact_id", contactId)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const result of [total, incoming, outgoing, first, last]) {
    if (result.error) throw result.error;
  }

  return {
    totalMessages: total.count ?? 0,
    incoming: incoming.count ?? 0,
    outgoing: outgoing.count ?? 0,
    firstMessageAt: first.data?.sent_at ?? null,
    lastMessageAt: last.data?.sent_at ?? null,
  };
}

/**
 * Escapes Postgres LIKE wildcards so a user searching for "50%" does not match
 * everything. Supabase's ilike has no parameter binding for the pattern.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
