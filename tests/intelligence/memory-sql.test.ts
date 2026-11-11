/**
 * Memory correction against real PostgreSQL.
 *
 * The fake client cannot prove the unique index works. This file exists because
 * `memories_active_fingerprint_key` is a *partial* unique index (only active
 * rows), and the repository's hand-written memory paths previously inserted rows
 * without a fingerprint — leaving them completely unconstrained. Only a real
 * database catches that.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDatabase, createUser } from "../helpers/pglite";
import { createPGliteClient } from "../helpers/pglite-client";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  archiveMemory,
  createMemory,
  DuplicateMemoryError,
  supersedeMemory,
} from "@/server/memories/repository";

let db: PGlite;
let close: () => Promise<void>;
let userId: string;
let contactId: string;
let client: ServerSupabaseClient;

beforeAll(async () => {
  const database = await createTestDatabase();
  db = database.db;
  close = database.close;

  userId = await createUser(db, "memory-sql@example.com");

  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (user_id, display_name, relationship_kind)
     values ($1, 'Priya', 'friend') returning id`,
    [userId],
  );
  contactId = contact.rows[0]!.id;
  client = createPGliteClient(db);
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe("memories on real PostgreSQL", () => {
  it("stores a hand-written memory with a valid fingerprint", async () => {
    const memory = await createMemory(client, userId, contactId, {
      category: "goal",
      statement: "Train for the Lisbon marathon",
    });

    expect(memory.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(memory.status).toBe("active");
    expect(memory.is_user_confirmed).toBe(true);
  });

  it("refuses a second active memory with the same normalised statement", async () => {
    await createMemory(client, userId, contactId, {
      category: "preference",
      statement: "Priya prefers evening runs",
    });

    // Same fact, different punctuation and case: must collide.
    await expect(
      createMemory(client, userId, contactId, {
        category: "preference",
        statement: "priya PREFERS evening runs!",
      }),
    ).rejects.toBeInstanceOf(DuplicateMemoryError);
  });

  it("allows a different fact that differs only by a word", async () => {
    await createMemory(client, userId, contactId, {
      category: "preference",
      statement: "Priya likes coffee",
    });

    // "dislikes" must not collide with "likes": a fact and its opposite differ.
    const opposite = await createMemory(client, userId, contactId, {
      category: "preference",
      statement: "Priya dislikes coffee",
    });

    expect(opposite.id).toBeTruthy();
  });

  it("supersedes the original so only the correction stays active", async () => {
    const original = await createMemory(client, userId, contactId, {
      category: "routine",
      statement: "Runs on Sunday mornings",
    });

    const corrected = await supersedeMemory(client, userId, original.id, {
      category: "routine",
      statement: "Runs on Sunday evenings",
    });

    const { rows } = await db.query<{ status: string; superseded_by: string | null }>(
      `select status, superseded_by from public.memories where id = $1`,
      [original.id],
    );

    expect(rows[0]?.status).toBe("superseded");
    expect(rows[0]?.superseded_by).toBe(corrected.id);
  });

  it("lets a corrected statement reuse a fingerprint freed by superseding", async () => {
    const original = await createMemory(client, userId, contactId, {
      category: "goal",
      statement: "Wants to learn Spanish",
    });

    const corrected = await supersedeMemory(client, userId, original.id, {
      category: "goal",
      statement: "Wants to learn Portuguese",
    });

    expect(corrected.statement).toBe("Wants to learn Portuguese");

    // The partial index only covers active rows, so the old fingerprint is free.
    const reuse = await createMemory(client, userId, contactId, {
      category: "goal",
      statement: "Wants to learn Spanish",
    });
    expect(reuse.id).toBeTruthy();
  });

  it("archives without deleting, freeing the fingerprint for a future memory", async () => {
    const memory = await createMemory(client, userId, contactId, {
      category: "boundary",
      statement: "Do not call before 9am",
    });

    await archiveMemory(client, userId, memory.id);

    const { rows } = await db.query<{ status: string }>(
      `select status from public.memories where id = $1`,
      [memory.id],
    );
    expect(rows[0]?.status).toBe("archived");

    const again = await createMemory(client, userId, contactId, {
      category: "boundary",
      statement: "Do not call before 9am",
    });
    expect(again.id).not.toBe(memory.id);
  });
});
