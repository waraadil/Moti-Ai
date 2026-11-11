/**
 * Contact data access.
 *
 * All queries are scoped to the owning user. Row Level Security enforces the
 * same rule at the database level, so a mistake here cannot leak data; the
 * explicit `.eq("user_id", ...)` is defence in depth and documents intent.
 */

import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import type { ContactRow, RelationshipKind } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { CreateContactInput, UpdateContactInput } from "@/lib/validation/schemas";

export async function listContacts(
  supabase: ServerSupabaseClient,
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ContactRow[]> {
  let query = supabase
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .order("display_name", { ascending: true });

  if (!options.includeArchived) {
    query = query.eq("is_archived", false);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data ?? [];
}

export async function getContact(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<ContactRow | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/** Like `getContact`, but raises a typed 404 for route handlers. */
export async function requireContact(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<ContactRow> {
  const contact = await getContact(supabase, userId, contactId);
  if (!contact) throw new NotFoundError("That contact does not exist or is not yours.");
  return contact;
}

export async function createContact(
  supabase: ServerSupabaseClient,
  userId: string,
  input: CreateContactInput,
): Promise<ContactRow> {
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      user_id: userId,
      display_name: input.displayName,
      relationship_kind: input.relationshipKind,
      phone_number: input.phoneNumber ?? null,
      whatsapp_jid: input.whatsappJid ?? null,
      notes: input.notes ?? null,
    })
    .select("*")
    .single();

  if (error) {
    // 23505 = unique violation. The partial indexes on (user_id, phone_number)
    // and (user_id, whatsapp_jid) make this reachable.
    if (error.code === "23505") {
      throw new ConflictError(
        "You already have a contact with that phone number or WhatsApp identifier.",
      );
    }
    throw error;
  }

  return data;
}

/**
 * Updates only the fields supplied. Never writes defaults over existing values,
 * so a partial form submission cannot blank out unrelated columns.
 */
export async function updateContact(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  input: UpdateContactInput,
): Promise<ContactRow> {
  const patch: {
    display_name?: string;
    relationship_kind?: RelationshipKind;
    notes?: string;
    is_archived?: boolean;
  } = {};

  if (input.displayName !== undefined) patch.display_name = input.displayName;
  if (input.relationshipKind !== undefined) patch.relationship_kind = input.relationshipKind;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.isArchived !== undefined) patch.is_archived = input.isArchived;

  if (Object.keys(patch).length === 0) return requireContact(supabase, userId, contactId);

  const { data, error } = await supabase
    .from("contacts")
    .update(patch)
    .eq("user_id", userId)
    .eq("id", contactId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("That contact does not exist or is not yours.");
  return data;
}

/**
 * Counts for the contact list. Uses two grouped queries instead of N+1
 * per-contact requests.
 */
export async function getContactCounts(
  supabase: ServerSupabaseClient,
  userId: string,
  contactIds: string[],
): Promise<Map<string, { activeMemoryCount: number; importCount: number }>> {
  const counts = new Map<string, { activeMemoryCount: number; importCount: number }>();

  for (const contactId of contactIds) {
    counts.set(contactId, { activeMemoryCount: 0, importCount: 0 });
  }

  if (contactIds.length === 0) return counts;

  const [memories, imports] = await Promise.all([
    supabase
      .from("memories")
      .select("contact_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .in("contact_id", contactIds),
    supabase
      .from("chat_imports")
      .select("contact_id")
      .eq("user_id", userId)
      .in("contact_id", contactIds),
  ]);

  if (memories.error) throw memories.error;
  if (imports.error) throw imports.error;

  for (const row of memories.data ?? []) {
    const entry = counts.get(row.contact_id);
    if (entry) entry.activeMemoryCount += 1;
  }

  for (const row of imports.data ?? []) {
    if (!row.contact_id) continue;
    const entry = counts.get(row.contact_id);
    if (entry) entry.importCount += 1;
  }

  return counts;
}
