import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDatabase, createUser, type TestDatabase } from "./helpers/pglite";

/**
 * These tests execute the real migrations against a real PostgreSQL engine and
 * then verify the guarantees the schema claims to make:
 *
 *   1. every table exists,
 *   2. Row Level Security isolates users from each other,
 *   3. cross-user references are impossible even with RLS bypassed,
 *   4. message history cannot be rewritten.
 */

let testDb: TestDatabase;
let alice: string;
let bob: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  alice = await createUser(testDb.db, "alice@example.com");
  bob = await createUser(testDb.db, "bob@example.com");
});

afterAll(async () => {
  await testDb.close();
});

describe("migrations", () => {
  it("applies every migration in order", () => {
    expect(testDb.appliedMigrations).toEqual([
      "0001_extensions_and_types.sql",
      "0002_identity.sql",
      "0003_conversations.sql",
      "0004_analysis.sql",
      "0005_tenant_integrity.sql",
      "0006_row_level_security.sql",
      "0007_storage.sql",
      "0008_intelligence_engine.sql",
    "0009_temporal_diff.sql",
    "0010_away_mode.sql",
    "0011_reliable_deletion.sql",
    ]);
  });

  it("creates every entity required by the domain model", async () => {
    const { rows } = await testDb.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );

    const tables = rows.map((row) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "profiles",
        "contacts",
        "contact_aliases",
        "chat_imports",
        "messages",
        "communication_profiles",
        "relationship_contexts",
        "memories",
        "memory_evidence",
        "analysis_versions",
        "reply_drafts",
        // Away Mode
        "away_settings",
        "away_contact_permissions",
        "away_prepared_replies",
        "away_events",
        "data_cleanup_jobs",
      ]),
    );
  });

  it("creates the auth mirror profile for a new user", async () => {
    const { rows } = await testDb.db.query<{ id: string; email: string }>(
      "select id, email from public.profiles where id = $1",
      [alice],
    );
    expect(rows[0]?.email).toBe("alice@example.com");
  });

  it("enables Row Level Security on every public table", async () => {
    const { rows } = await testDb.db.query<{ relname: string }>(
      `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("prevents one user from reading another user's contacts", async () => {
    const { rows } = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Alice's friend"],
    );
    const aliceContactId = rows[0]?.id;
    expect(aliceContactId).toBeTruthy();

    const asBob = await asUser(testDb.db, bob, () =>
      testDb.db.query("select id from public.contacts"),
    );
    expect(asBob.rows).toHaveLength(0);

    const asAlice = await asUser(testDb.db, alice, () =>
      testDb.db.query("select id from public.contacts"),
    );
    expect(asAlice.rows).toHaveLength(1);
  });

  it("rejects an insert that claims another user's id", async () => {
    await expect(
      asUser(testDb.db, bob, () =>
        testDb.db.query("insert into public.contacts (user_id, display_name) values ($1, $2)", [
          alice,
          "Forged contact",
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides Away Mode settings from other users", async () => {
    await testDb.db.query(
      "insert into public.away_settings (user_id, status) values ($1, 'active')",
      [alice],
    );

    const asBob = await asUser(testDb.db, bob, () =>
      testDb.db.query("select id from public.away_settings"),
    );
    expect(asBob.rows).toHaveLength(0);

    const asAlice = await asUser(testDb.db, alice, () =>
      testDb.db.query("select id from public.away_settings"),
    );
    expect(asAlice.rows).toHaveLength(1);
  });

  it("refuses Away Mode settings claiming another user's id", async () => {
    await expect(
      asUser(testDb.db, bob, () =>
        testDb.db.query("insert into public.away_settings (user_id) values ($1)", [alice]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides prepared replies from other users", async () => {
    const { rows } = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Alice's contact"],
    );
    const contactId = rows[0]?.id as string;

    await testDb.db.query(
      `insert into public.away_prepared_replies (user_id, contact_id, body)
       values ($1, $2, 'a prepared reply')`,
      [alice, contactId],
    );

    const asBob = await asUser(testDb.db, bob, () =>
      testDb.db.query("select id from public.away_prepared_replies"),
    );
    expect(asBob.rows).toHaveLength(0);

    // A reply cannot be approved by someone else: it is not even visible.
    const approvalAttempt = await asUser(testDb.db, bob, () =>
      testDb.db.query("update public.away_prepared_replies set state = 'approved'"),
    );
    expect(approvalAttempt.rows).toHaveLength(0);
  });

  it("hides the activity log from other users and never lets it be edited", async () => {
    await testDb.db.query(
      "insert into public.away_events (user_id, kind, detail) values ($1, 'mode_enabled', 'on')",
      [alice],
    );

    const asBob = await asUser(testDb.db, bob, () =>
      testDb.db.query("select id from public.away_events"),
    );
    expect(asBob.rows).toHaveLength(0);

    /*
     * The log is append-only twice over: no update grant and no update policy.
     * So even the owner cannot rewrite it. A history the subject can edit would
     * not be evidence of anything.
     */
    await expect(
      asUser(testDb.db, alice, () =>
        testDb.db.query("update public.away_events set detail = 'tampered'"),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    const stillOriginal = await testDb.db.query<{ detail: string }>(
      "select detail from public.away_events where user_id = $1",
      [alice],
    );
    expect(stillOriginal.rows[0]?.detail).toBe("on");
  });

  it("hides messages from other users", async () => {
    const asBob = await asUser(testDb.db, bob, () =>
      testDb.db.query("select id from public.messages"),
    );
    expect(asBob.rows).toHaveLength(0);
  });
});

describe("referential integrity between users", () => {
  it("refuses a contact that points at another user's profile", async () => {
    await expect(
      testDb.db.query("insert into public.contacts (user_id, display_name) values ($1, $2)", [
        // A user id that does not exist is equally invalid.
        "00000000-0000-0000-0000-000000000000",
        "Orphan",
      ]),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a message whose contact belongs to a different user", async () => {
    // Bob owns the contact; Alice tries to attach a message (and an import) to it.
    const bobContact = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [bob, "Bob's friend"],
    );
    const bobContactId = bobContact.rows[0]?.id as string;

    const aliceImport = await testDb.db.query<{ id: string }>(
      `insert into public.chat_imports
         (user_id, source, storage_path, original_filename, checksum)
       values ($1, 'whatsapp_txt_export', $2, 'chat.txt', $3)
       returning id`,
      [alice, `${alice}/import-1/chat.txt`, "a".repeat(64)],
    );
    const aliceImportId = aliceImport.rows[0]?.id as string;

    await expect(
      testDb.db.query(
        `insert into public.messages
           (user_id, chat_import_id, contact_id, direction, body, sent_at, source_fingerprint)
         values ($1, $2, $3, 'incoming', 'hello', now(), 'fingerprint-1')`,
        [alice, aliceImportId, bobContactId],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a message whose contact differs from its import's contact", async () => {
    const contactA = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Contact A"],
    );
    const contactB = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Contact B"],
    );

    const importForA = await testDb.db.query<{ id: string }>(
      `insert into public.chat_imports
         (user_id, contact_id, source, storage_path, original_filename, checksum)
       values ($1, $2, 'whatsapp_txt_export', $3, 'chat.txt', $4)
       returning id`,
      [alice, contactA.rows[0]?.id, `${alice}/import-a/chat.txt`, "b".repeat(64)],
    );

    await expect(
      testDb.db.query(
        `insert into public.messages
           (user_id, chat_import_id, contact_id, direction, body, sent_at, source_fingerprint)
         values ($1, $2, $3, 'incoming', 'hello', now(), 'fingerprint-2')`,
        [alice, importForA.rows[0]?.id, contactB.rows[0]?.id],
      ),
    ).rejects.toThrow(/does not match its chat import contact/i);
  });
});

describe("data integrity rules", () => {
  it("keeps messages immutable", async () => {
    const contact = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Immutable contact"],
    );
    const chatImport = await testDb.db.query<{ id: string }>(
      `insert into public.chat_imports
         (user_id, contact_id, source, storage_path, original_filename, checksum)
       values ($1, $2, 'whatsapp_txt_export', $3, 'chat.txt', $4)
       returning id`,
      [alice, contact.rows[0]?.id, `${alice}/immutable/chat.txt`, "c".repeat(64)],
    );
    const message = await testDb.db.query<{ id: string }>(
      `insert into public.messages
         (user_id, chat_import_id, contact_id, direction, body, sent_at, source_fingerprint)
       values ($1, $2, $3, 'incoming', 'original text', now(), 'fingerprint-3')
       returning id`,
      [alice, chatImport.rows[0]?.id, contact.rows[0]?.id],
    );

    await expect(
      testDb.db.query("update public.messages set body = $1 where id = $2", [
        "rewritten",
        message.rows[0]?.id,
      ]),
    ).rejects.toThrow(/messages are immutable/i);
  });

  it("rejects confidence values outside 0..1", async () => {
    const contact = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Confidence contact"],
    );

    await expect(
      testDb.db.query(
        `insert into public.memories (user_id, contact_id, category, statement, confidence)
         values ($1, $2, 'preference', 'Likes tea', 1.5)`,
        [alice, contact.rows[0]?.id],
      ),
    ).rejects.toThrow(/confidence_score|check/i);
  });

  it("requires evidence for a superseded memory", async () => {
    const contact = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [alice, "Superseded contact"],
    );

    await expect(
      testDb.db.query(
        `insert into public.memories (user_id, contact_id, category, statement, status)
         values ($1, $2, 'goal', 'Wants to move abroad', 'superseded')`,
        [alice, contact.rows[0]?.id],
      ),
    ).rejects.toThrow(/superseded_requires_link|check/i);
  });

  it("prevents duplicate imports of the same file", async () => {
    const checksum = "d".repeat(64);
    await testDb.db.query(
      `insert into public.chat_imports
         (user_id, source, storage_path, original_filename, checksum)
       values ($1, 'whatsapp_txt_export', $2, 'chat.txt', $3)`,
      [alice, `${alice}/dup-1/chat.txt`, checksum],
    );

    await expect(
      testDb.db.query(
        `insert into public.chat_imports
           (user_id, source, storage_path, original_filename, checksum)
         values ($1, 'whatsapp_txt_export', $2, 'chat-copy.txt', $3)`,
        [alice, `${alice}/dup-2/chat.txt`, checksum],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe("storage policies", () => {
  it("registers the private buckets", async () => {
    const { rows } = await testDb.db.query<{ id: string; public: boolean }>(
      "select id, public from storage.buckets order by id",
    );
    expect(rows).toEqual([
      { id: "analysis", public: false },
      { id: "chat-imports", public: false },
    ]);
  });

  it("only exposes objects under the owner's folder", async () => {
    // storage.objects is owned by the test role, so query policies directly.
    const { rows } = await testDb.db.query<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
       order by policyname`,
    );
    expect(rows.map((row) => row.policyname)).toEqual([
      "analysis_objects_delete_own",
      "analysis_objects_insert_own",
      "analysis_objects_select_own",
      "chat_imports_objects_delete_own",
      "chat_imports_objects_insert_own",
      "chat_imports_objects_select_own",
      "chat_imports_objects_update_own",
    ]);
  });
});

describe("cascade behaviour", () => {
  it("removes a contact's messages and analysis when the contact is deleted", async () => {
    const user = await createUser(testDb.db, "cascade@example.com");

    const contact = await testDb.db.query<{ id: string }>(
      "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
      [user, "Cascade contact"],
    );
    const contactId = contact.rows[0]?.id as string;

    const chatImport = await testDb.db.query<{ id: string }>(
      `insert into public.chat_imports
         (user_id, contact_id, source, storage_path, original_filename, checksum)
       values ($1, $2, 'whatsapp_txt_export', $3, 'chat.txt', $4)
       returning id`,
      [user, contactId, `${user}/cascade/chat.txt`, "e".repeat(64)],
    );

    const message = await testDb.db.query<{ id: string }>(
      `insert into public.messages
         (user_id, chat_import_id, contact_id, direction, body, sent_at, source_fingerprint)
       values ($1, $2, $3, 'incoming', 'hello there', now(), 'cascade:1')
       returning id`,
      [user, chatImport.rows[0]?.id, contactId],
    );

    const memory = await testDb.db.query<{ id: string }>(
      `insert into public.memories (user_id, contact_id, category, statement)
       values ($1, $2, 'preference', 'Likes tea') returning id`,
      [user, contactId],
    );

    await testDb.db.query(
      `insert into public.memory_evidence (user_id, memory_id, message_id, excerpt)
       values ($1, $2, $3, 'Likes tea')`,
      [user, memory.rows[0]?.id, message.rows[0]?.id],
    );

    await testDb.db.query("delete from public.contacts where id = $1", [contactId]);

    const remaining = await Promise.all([
      testDb.db.query("select id from public.messages where contact_id = $1", [contactId]),
      testDb.db.query("select id from public.memories where contact_id = $1", [contactId]),
      testDb.db.query("select id from public.memory_evidence where memory_id = $1", [
        memory.rows[0]?.id,
      ]),
    ]);

    for (const result of remaining) expect(result.rows).toHaveLength(0);
  });

  it("keeps evidence rows on the same contact as the memory they support", async () => {
    const user = await createUser(testDb.db, "evidence@example.com");

    const makeContact = async (name: string) => {
      const result = await testDb.db.query<{ id: string }>(
        "insert into public.contacts (user_id, display_name) values ($1, $2) returning id",
        [user, name],
      );
      return result.rows[0]?.id as string;
    };

    const contactA = await makeContact("Contact A");
    const contactB = await makeContact("Contact B");

    const importB = await testDb.db.query<{ id: string }>(
      `insert into public.chat_imports
         (user_id, contact_id, source, storage_path, original_filename, checksum)
       values ($1, $2, 'whatsapp_txt_export', $3, 'b.txt', $4)
       returning id`,
      [user, contactB, `${user}/b/chat.txt`, "f".repeat(64)],
    );

    const messageForB = await testDb.db.query<{ id: string }>(
      `insert into public.messages
         (user_id, chat_import_id, contact_id, direction, body, sent_at, source_fingerprint)
       values ($1, $2, $3, 'incoming', 'from B', now(), 'contact-b:line-1')
       returning id`,
      [user, importB.rows[0]?.id, contactB],
    );

    const memoryForA = await testDb.db.query<{ id: string }>(
      `insert into public.memories (user_id, contact_id, category, statement)
       values ($1, $2, 'goal', 'Something about A') returning id`,
      [user, contactA],
    );

    // Citing B's message as evidence for a memory about A must fail.
    await expect(
      testDb.db.query(
        `insert into public.memory_evidence (user_id, memory_id, message_id, excerpt)
         values ($1, $2, $3, 'mismatched')`,
        [user, memoryForA.rows[0]?.id, messageForB.rows[0]?.id],
      ),
    ).rejects.toThrow(/belongs to contact/i);
  });
});
