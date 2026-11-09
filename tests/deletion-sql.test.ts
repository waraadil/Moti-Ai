/**
 * Deletion against a real PostgreSQL engine.
 *
 * The application tests run against an in-memory fake, which can only prove the
 * code calls the right things. These run the real migrations and the real
 * `delete_contact_data` / `delete_all_user_data` functions, so the properties
 * that actually matter are verified by the database itself:
 *
 *   - a failure part-way through rolls back every row
 *   - the caller cannot delete another user's data
 *   - storage paths are queued, not silently dropped
 *   - profile anonymisation clears identifying fields but keeps the account ref
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asUser, createTestDatabase, createUser, type TestDatabase } from "./helpers/pglite";

let testDb: TestDatabase;
let alice: string;
let bob: string;

/** Creates a contact plus a message for a user, returning the contact id. */
async function seedConversation(userId: string, label: string): Promise<string> {
  const contact = await testDb.db.query<{ id: string }>(
    "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
    [userId, label],
  );
  const contactId = contact.rows[0]?.id as string;

  const imported = await testDb.db.query<{ id: string }>(
    `insert into public.chat_imports
       (user_id, contact_id, source, status, storage_path, original_filename, byte_size,
        completed_at)
     values ($1, $2, 'whatsapp_txt_export', 'completed', $3, 'chat.txt', 100, now())
     returning id`,
    [userId, contactId, `${userId}/${contactId}/chat.txt`],
  );
  const importId = imported.rows[0]?.id as string;

  await testDb.db.query(
    `insert into public.messages
       (user_id, contact_id, chat_import_id, sender_label, direction, kind, body, sent_at,
        source_fingerprint)
     values ($1, $2, $3, 'Priya', 'incoming', 'text', 'hello', now(), $4)`,
    [userId, contactId, importId, `fp-msg-${contactId}`],
  );

  await testDb.db.query(
    `insert into public.memories (user_id, contact_id, statement, category, fingerprint)
     values ($1, $2, 'a fact', 'preference', $3)`,
    [userId, contactId, `fp-${contactId}`],
  );

  return contactId;
}

async function countRows(table: string, userId: string): Promise<number> {
  const result = await testDb.db.query<{ count: string }>(
    `select count(*)::text as count from public.${table} where user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  alice = await createUser(testDb.db, "alice@example.com");
  bob = await createUser(testDb.db, "bob@example.com");
});

/**
 * Clears user data but keeps the accounts.
 *
 * These tests share one database (migrations take seconds), so state must not
 * leak between them: a leftover cleanup job from one test would make the next
 * one's "exactly one queued file" assertion meaningless.
 */
beforeEach(async () => {
  await testDb.db.query(
    `truncate table
       public.data_cleanup_jobs,
       public.away_prepared_replies,
       public.away_events,
       public.away_contact_permissions,
       public.away_settings,
       public.reply_drafts,
       public.conversation_snapshots,
       public.analysis_runs,
       public.analysis_versions,
       public.memory_evidence,
       public.memories,
       public.relationship_contexts,
       public.communication_profiles,
       public.contact_aliases,
       public.messages,
       public.chat_imports,
       public.contacts
     restart identity cascade`,
  );

  // Restore a known profile state: an earlier test anonymises Alice.
  await testDb.db.query(
    `update public.profiles
        set email = 'alice@example.com', display_name = 'Alice', timezone = 'UTC'
      where id = $1`,
    [alice],
  );
});

afterAll(async () => {
  await testDb.close();
});

describe("delete_contact_data", () => {
  it("removes the contact, its messages and its derived rows in one call", async () => {
    const contactId = await seedConversation(alice, "Priya");

    const result = await asUser(testDb.db, alice, () =>
      testDb.db.query<{ deleted: Record<string, number> }>(
        "select public.delete_contact_data($1) as deleted",
        [contactId],
      ),
    );

    const payload = result.rows[0]?.deleted as unknown as { deleted: Record<string, number> };
    expect(payload.deleted.contacts).toBe(1);
    expect(payload.deleted.messages).toBe(1);

    expect(await countRows("contacts", alice)).toBe(0);
    expect(await countRows("messages", alice)).toBe(0);
    expect(await countRows("memories", alice)).toBe(0);
  });

  it("queues the storage path instead of losing it", async () => {
    const contactId = await seedConversation(alice, "Queue test");

    await asUser(testDb.db, alice, () =>
      testDb.db.query("select public.delete_contact_data($1)", [contactId]),
    );

    const jobs = await testDb.db.query<{ object_path: string }>(
      "select object_path from public.data_cleanup_jobs where user_id = $1",
      [alice],
    );

    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.object_path).toContain(contactId);
  });

  it("reports complete = false while the file is still queued", async () => {
    const contactId = await seedConversation(alice, "Completeness");

    const result = await asUser(testDb.db, alice, () =>
      testDb.db.query<{ r: { complete: boolean; queued_files: number } }>(
        "select public.delete_contact_data($1) as r",
        [contactId],
      ),
    );

    const payload = result.rows[0]?.r;
    expect(payload?.queued_files).toBe(1);
    // The file has not been removed, so the deletion is honestly incomplete.
    expect(payload?.complete).toBe(false);
  });

  it("refuses a contact belonging to someone else", async () => {
    const bobContact = await seedConversation(bob, "Sam");

    await expect(
      asUser(testDb.db, alice, () =>
        testDb.db.query("select public.delete_contact_data($1)", [bobContact]),
      ),
    ).rejects.toThrow(/not found or not yours/);

    expect(await countRows("contacts", bob)).toBe(1);
  });

  it("refuses to run without an authenticated user", async () => {
    const contactId = await seedConversation(alice, "No auth");

    await expect(
      testDb.db.query("select public.delete_contact_data($1)", [contactId]),
    ).rejects.toThrow(/not authenticated/);
  });
});

describe("delete_all_user_data", () => {
  it("clears every row for the caller and nobody else", async () => {
    const aliceContact = await seedConversation(alice, "Alice friend");
    const bobContact = await seedConversation(bob, "Bob friend");

    await asUser(testDb.db, alice, () =>
      testDb.db.query("select public.delete_all_user_data(true)"),
    );

    expect(await countRows("contacts", alice)).toBe(0);
    expect(await countRows("messages", alice)).toBe(0);

    // Bob is untouched.
    expect(await countRows("contacts", bob)).toBe(1);
    expect(await countRows("messages", bob)).toBe(1);

    expect(aliceContact).not.toBe(bobContact);
  });

  it("anonymises the profile but keeps the account reference", async () => {
    await testDb.db.query(
      "update public.profiles set display_name = 'Alice Real', timezone = 'Asia/Kolkata' where id = $1",
      [alice],
    );

    await asUser(testDb.db, alice, () =>
      testDb.db.query("select public.delete_all_user_data(true)"),
    );

    const profile = await testDb.db.query<{
      id: string;
      email: string | null;
      display_name: string | null;
      timezone: string;
    }>("select id, email, display_name, timezone from public.profiles where id = $1", [alice]);

    const row = profile.rows[0];
    // Identifying content gone.
    expect(row?.email).toBeNull();
    expect(row?.display_name).toBe("Deleted account");
    expect(row?.timezone).toBe("UTC");
    // The bare account identifier remains, because it *is* the account.
    expect(row?.id).toBe(alice);
  });

  it("is idempotent: a second call removes nothing and does not error", async () => {
    await asUser(testDb.db, alice, () =>
      testDb.db.query("select public.delete_all_user_data(true)"),
    );

    const second = await asUser(testDb.db, alice, () =>
      testDb.db.query<{ r: { deleted: Record<string, number> } }>(
        "select public.delete_all_user_data(true) as r",
      ),
    );

    const payload = second.rows[0]?.r;
    expect(payload?.deleted.contacts ?? 0).toBe(0);
  });
});

describe("rollback", () => {
  /*
   * The core of the reported bug: a genuine mid-function failure must leave the
   * database untouched. Rather than simulating with statements, this installs a
   * trigger that raises inside `delete_contact_data` part-way through its
   * sequence, so the rollback exercised is PostgreSQL's own.
   */
  it("rolls back every delete when a later statement fails", async () => {
    const contactId = await seedConversation(alice, "Rollback target");

    const before = {
      contacts: await countRows("contacts", alice),
      messages: await countRows("messages", alice),
      memories: await countRows("memories", alice),
      imports: await countRows("chat_imports", alice),
    };
    expect(before.messages).toBe(1);

    /*
     * `messages` is deleted late in the sequence, after memories and analysis
     * rows, and there is definitely a row there. Raising here proves that the
     * deletes already performed are undone.
     */
    await testDb.db.exec(`
      create or replace function public.__fail_on_delete() returns trigger
      language plpgsql as $$
      begin
        raise exception 'simulated mid-transaction failure';
      end;
      $$;

      create trigger __simulate_failure
        before delete on public.messages
        for each row execute function public.__fail_on_delete();
    `);

    try {
      await expect(
        asUser(testDb.db, alice, () =>
          testDb.db.query("select public.delete_contact_data($1)", [contactId]),
        ),
      ).rejects.toThrow(/simulated mid-transaction failure/);
    } finally {
      await testDb.db.exec(`
        drop trigger if exists __simulate_failure on public.messages;
        drop function if exists public.__fail_on_delete();
      `);
    }

    // Everything is exactly as it was: no partial deletion.
    expect(await countRows("contacts", alice)).toBe(before.contacts);
    expect(await countRows("messages", alice)).toBe(before.messages);
    expect(await countRows("memories", alice)).toBe(before.memories);
    expect(await countRows("chat_imports", alice)).toBe(before.imports);

    // And no storage work was queued, because the queue insert rolled back too.
    const jobs = await testDb.db.query<{ count: string }>(
      "select count(*)::text as count from public.data_cleanup_jobs where user_id = $1",
      [alice],
    );
    expect(jobs.rows[0]?.count).toBe("0");
  });
});
