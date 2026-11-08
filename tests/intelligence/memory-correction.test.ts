import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  archiveMemory,
  createMemory,
  fingerprintStatement,
  listMemories,
  supersedeMemory,
} from "@/server/memories/repository";
import { memoryFingerprint } from "@/lib/intelligence/fingerprint";
import { NotFoundError } from "@/lib/errors";
import { memoryCorrectionSchema } from "@/lib/validation/schemas";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let fake: FakeSupabase;
let client: ServerSupabaseClient;

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
});

const BASE = {
  category: "preference" as const,
  statement: "Priya prefers evening runs",
};

describe("fingerprinting", () => {
  it("is the same function the analysis pipeline uses", () => {
    expect(fingerprintStatement("Priya likes coffee")).toBe(
      memoryFingerprint("Priya likes coffee"),
    );
  });

  it("produces a 64-character hex hash matching the schema constraint", () => {
    expect(fingerprintStatement("anything at all")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("creating a memory by hand", () => {
  it("marks it confirmed by the user and sets a fingerprint", async () => {
    const memory = await createMemory(client, USER_ID, CONTACT_ID, BASE);

    expect(memory.is_user_confirmed).toBe(true);
    expect(memory.status).toBe("active");
    // Without this the unique index cannot stop duplicates.
    expect(memory.fingerprint).toBe(fingerprintStatement(BASE.statement));
  });

  it("fingerprints so a re-run of analysis does not duplicate it", async () => {
    const memory = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    expect(memory.fingerprint).toBeTruthy();
    expect(String(memory.fingerprint)).toHaveLength(64);
  });
});

describe("correcting a memory", () => {
  it("replaces the statement and keeps the original as superseded", async () => {
    const original = await createMemory(client, USER_ID, CONTACT_ID, BASE);

    const corrected = await supersedeMemory(client, USER_ID, original.id, {
      category: "preference",
      statement: "Priya prefers early morning runs",
    });

    expect(corrected.statement).toBe("Priya prefers early morning runs");
    expect(corrected.id).not.toBe(original.id);
    expect(corrected.is_user_confirmed).toBe(true);

    const [reloaded] = await listMemories(client, USER_ID, CONTACT_ID, { status: "superseded" });
    expect(reloaded?.id).toBe(original.id);
    expect(reloaded?.superseded_by).toBe(corrected.id);

    // Only the correction is active.
    const active = await listMemories(client, USER_ID, CONTACT_ID, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(corrected.id);
  });

  it("carries observed-at timestamps across the correction", async () => {
    const original = await createMemory(client, USER_ID, CONTACT_ID, {
      ...BASE,
      statement: "Priya runs in the evening",
    });

    const corrected = await supersedeMemory(client, USER_ID, original.id, {
      category: "routine",
      statement: "Priya runs in the early evening",
    });

    expect(corrected.first_observed_at).toBe(original.first_observed_at);
    expect(corrected.last_observed_at).toBe(original.last_observed_at);
  });

  it("refuses to correct a memory that has already been replaced", async () => {
    const original = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    await supersedeMemory(client, USER_ID, original.id, {
      category: "preference",
      statement: "Priya runs at dawn",
    });

    await expect(
      supersedeMemory(client, USER_ID, original.id, {
        category: "preference",
        statement: "Priya runs at noon",
      }),
    ).rejects.toThrow(/already been replaced/i);
  });

  it("refuses to correct another user's memory", async () => {
    const original = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    const otherUser = "22222222-2222-4222-8222-222222222222";

    await expect(
      supersedeMemory(client, otherUser, original.id, {
        category: "preference",
        statement: "hijacked",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleting a memory", () => {
  it("archives rather than hard-deletes, so history survives", async () => {
    const memory = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    await archiveMemory(client, USER_ID, memory.id);

    const active = await listMemories(client, USER_ID, CONTACT_ID, { status: "active" });
    expect(active).toEqual([]);

    const archived = await listMemories(client, USER_ID, CONTACT_ID, { status: "archived" });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.statement).toBe(BASE.statement);
  });

  it("cannot archive a memory twice", async () => {
    const memory = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    await archiveMemory(client, USER_ID, memory.id);

    await expect(archiveMemory(client, USER_ID, memory.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot archive another user's memory", async () => {
    const memory = await createMemory(client, USER_ID, CONTACT_ID, BASE);
    await expect(
      archiveMemory(client, "22222222-2222-4222-8222-222222222222", memory.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("manual memory validation", () => {
  it("rejects an empty statement", () => {
    expect(memoryCorrectionSchema.safeParse({ category: "goal", statement: "  " }).success).toBe(
      false,
    );
  });

  it("rejects a category the database does not accept", () => {
    expect(
      memoryCorrectionSchema.safeParse({ category: "made_up", statement: "a fact" }).success,
    ).toBe(false);
  });

  it("accepts a valid statement and trims it", () => {
    const parsed = memoryCorrectionSchema.safeParse({
      category: "goal",
      statement: "  Train for the Lisbon marathon  ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.statement).toBe("Train for the Lisbon marathon");
  });
});
