/**
 * End-to-end pipeline test against real PostgreSQL.
 *
 * The fake client proves the orchestration logic; this proves the SQL, the
 * constraints, the uniqueness of fingerprints and the versioning rules actually
 * hold in the database.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDatabase, createUser, asUser } from "../helpers/pglite";
import { createPGliteClient } from "../helpers/pglite-client";
import { runAnalysis, memoryFingerprint } from "@/server/analysis/pipeline";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { ProviderBundle } from "@/lib/ai";
import type { MessageRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { buildPriyaConversation, buildPriyaConversationExtended } from "../fixtures/conversations";

let db: PGlite;
let close: () => Promise<void>;
let userId: string;
let contactId: string;
let client: ServerSupabaseClient;

const provider: ProviderBundle = {
  kind: "deterministic",
  provider: new DeterministicProvider(),
};

/** Rewrites fixture ids/ownership so they can be inserted for the test user. */
function ownedMessages(rows: MessageRow[], importId: string): MessageRow[] {
  return rows.map((row) => ({
    ...row,
    user_id: userId,
    contact_id: contactId,
    chat_import_id: importId,
  }));
}

async function insertImport(id: string, externalId: string) {
  await db.query(
    `insert into public.chat_imports
      (id, user_id, contact_id, source, original_filename, storage_path, checksum,
       status, parsed_messages, completed_at)
     values ($1, $2, $3, 'whatsapp_txt_export', $4, $5, $6, 'completed', 0, now())`,
    [
      id,
      userId,
      contactId,
      `${externalId}.txt`,
      `${userId}/${externalId}.txt`,
      // Checksums must look like sha256 hex to satisfy the table constraint.
      externalId.padEnd(64, "0").replace(/[^a-f0-9]/g, "a"),
    ],
  );
}

async function persistMessages(rows: MessageRow[]) {
  for (const row of rows) {
    await db.query(
      `insert into public.messages
        (id, user_id, contact_id, chat_import_id, direction, kind, sender_label,
         sent_at, body, raw_line, line_number, source_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [
        row.id,
        row.user_id,
        row.contact_id,
        row.chat_import_id,
        row.direction,
        row.kind,
        row.sender_label,
        row.sent_at,
        row.body,
        row.raw_line,
        row.line_number,
        row.source_fingerprint,
      ],
    );
  }
}

async function loadMessages(): Promise<MessageRow[]> {
  const result = await asUser(db, userId, () =>
    db.query<MessageRow>(
      `select * from public.messages where contact_id = $1 and user_id = $2 order by sent_at asc`,
      [contactId, userId],
    ),
  );
  return result.rows;
}

beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  close = database.close;

  userId = await createUser(db, "wara@example.com");

  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (user_id, display_name, relationship_kind)
     values ($1, 'Priya', 'friend') returning id`,
    [userId],
  );
  contactId = contact.rows[0]!.id;

  client = createPGliteClient(db);

  await insertImport("11111111-1111-4111-8111-111111111111", "import-one");
  await persistMessages(
    ownedMessages(buildPriyaConversation(), "11111111-1111-4111-8111-111111111111"),
  );
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe("pipeline on real PostgreSQL", () => {
  it("writes a version, both profiles, memories with evidence, and a snapshot", async () => {
    const messages = await loadMessages();
    expect(messages.length).toBeGreaterThan(30);

    const outcome = await runAnalysis({
      userId,
      contactId,
      contactName: "Priya",
      selfName: "Wara",
      messages,
      supabase: client,
      provider,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.memoriesInserted).toBeGreaterThan(0);

    const versions = await db.query<{ count: string }>(
      `select count(*)::text from public.analysis_versions where contact_id = $1`,
      [contactId],
    );
    expect(versions.rows[0]?.count).toBe("1");

    const profiles = await db.query<{ participant: string; is_populated: boolean }>(
      `select participant, is_populated from public.communication_profiles
       where contact_id = $1 order by participant`,
      [contactId],
    );
    expect(profiles.rows).toHaveLength(2);
    expect(profiles.rows.every((row) => row.is_populated)).toBe(true);

    // Every stored memory has evidence, and the evidence carries the speaker
    // and timestamp from the original message.
    const orphans = await db.query<{ count: string }>(
      `select count(*)::text from public.memories m
       where m.contact_id = $1
         and not exists (select 1 from public.memory_evidence e where e.memory_id = m.id)`,
      [contactId],
    );
    expect(orphans.rows[0]?.count).toBe("0");

    const evidence = await db.query<{
      speaker_label: string | null;
      said_at: string | null;
      evidence_status: string;
    }>(
      `select e.speaker_label, e.said_at, e.evidence_status
       from public.memory_evidence e
       join public.memories m on m.id = e.memory_id
       where m.contact_id = $1`,
      [contactId],
    );
    expect(evidence.rows.length).toBeGreaterThan(0);
    for (const row of evidence.rows) {
      expect(row.speaker_label).toBeTruthy();
      expect(row.said_at).toBeTruthy();
      expect(["direct", "inferred", "user_asserted"]).toContain(row.evidence_status);
    }

    const snapshots = await db.query<{ count: string }>(
      `select count(*)::text from public.conversation_snapshots where contact_id = $1`,
      [contactId],
    );
    expect(snapshots.rows[0]?.count).toBe("1");
  }, 120_000);

  it("does not create a second version or duplicate memories on identical input", async () => {
    const before = await db.query<{ count: string }>(
      `select count(*)::text from public.memories where contact_id = $1`,
      [contactId],
    );

    const outcome = await runAnalysis({
      userId,
      contactId,
      contactName: "Priya",
      selfName: "Wara",
      messages: await loadMessages(),
      supabase: client,
      provider,
    });

    expect(outcome.status).toBe("cached");

    const after = await db.query<{ count: string }>(
      `select count(*)::text from public.memories where contact_id = $1`,
      [contactId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    const versions = await db.query<{ count: string }>(
      `select count(*)::text from public.analysis_versions where contact_id = $1`,
      [contactId],
    );
    expect(versions.rows[0]?.count).toBe("1");
  }, 120_000);

  it("versions a later import and never duplicates a memory", async () => {
    await insertImport("22222222-2222-4222-8222-222222222222", "import-two");
    await persistMessages(
      ownedMessages(buildPriyaConversationExtended(), "22222222-2222-4222-8222-222222222222"),
    );

    const outcome = await runAnalysis({
      userId,
      contactId,
      contactName: "Priya",
      selfName: "Wara",
      messages: await loadMessages(),
      supabase: client,
      provider,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.version).toBe(2);
    expect(outcome.temporal?.hasPrevious).toBe(true);
    expect(outcome.temporal?.newMessageCount).toBeGreaterThan(0);

    // The previous version is superseded, not deleted.
    const versions = await db.query<{
      version: number;
      status: string;
      superseded_by: string | null;
    }>(
      `select version, status, superseded_by from public.analysis_versions
       where contact_id = $1 order by version`,
      [contactId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]?.status).toBe("superseded");
    expect(versions.rows[0]?.superseded_by).toBeTruthy();

    // The database's partial unique index guarantees no duplicate active
    // fingerprint, and the pipeline's pre-check means no error was thrown.
    const duplicates = await db.query<{ fingerprint: string; count: string }>(
      `select fingerprint, count(*)::text from public.memories
       where contact_id = $1 and status = 'active'
       group by fingerprint having count(*) > 1`,
      [contactId],
    );
    expect(duplicates.rows).toHaveLength(0);

    const snapshots = await db.query<{ count: string }>(
      `select count(*)::text from public.conversation_snapshots where contact_id = $1`,
      [contactId],
    );
    expect(snapshots.rows[0]?.count).toBe("2");
  }, 180_000);

  it("enforces the fingerprint format and uniqueness in the database itself", async () => {
    const memories = await db.query<{ id: string; fingerprint: string; statement: string }>(
      `select id, fingerprint, statement from public.memories where contact_id = $1 limit 1`,
      [contactId],
    );
    const existing = memories.rows[0];
    expect(existing).toBeDefined();
    expect(existing?.fingerprint).toBe(memoryFingerprint(existing!.statement));

    await expect(
      db.query(
        `insert into public.memories (user_id, contact_id, category, statement, fingerprint, confidence)
         values ($1, $2, 'preference', $3, $4, 0.5)`,
        [userId, contactId, `${existing!.statement} (copy)`, existing!.fingerprint],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  }, 60_000);

  it("records the run as completed with its version attached", async () => {
    const runs = await db.query<{
      status: string;
      attempts: number;
      analysis_version_id: string | null;
      input_messages: number;
    }>(
      `select status, attempts, analysis_version_id, input_messages from public.analysis_runs
       where contact_id = $1 order by created_at`,
      [contactId],
    );

    expect(runs.rows.length).toBeGreaterThan(0);
    for (const run of runs.rows) {
      expect(run.status).toBe("completed");
      expect(run.analysis_version_id).toBeTruthy();
      expect(run.input_messages).toBeGreaterThan(0);
    }
  }, 60_000);
});
