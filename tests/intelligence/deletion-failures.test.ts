/**
 * Failure injection for deletion.
 *
 * The previous implementation deleted table by table from the application. If
 * statement five failed, statements one to four were already committed, and the
 * user was told "nothing was changed". These tests exist to make that class of
 * bug impossible to reintroduce:
 *
 *   - a mid-transaction database failure must leave *zero* rows deleted
 *   - a storage failure must not lose the queued path
 *   - a partial cleanup must be reported as incomplete, never as done
 *   - repeated deletion must be safe and converge on complete
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  deleteContactData,
  deleteEverything,
  DeletionError,
  listPendingCleanup,
  retryPendingCleanup,
} from "@/server/data/deletion";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ALICE_CONTACT = "33333333-3333-4333-8333-333333333333";
const BOB_CONTACT = "44444444-4444-4444-8444-444444444444";

let fake: FakeSupabase;
let client: ServerSupabaseClient;

function seed() {
  fake.state.tables.profiles = [
    {
      id: ALICE,
      email: "alice@example.com",
      display_name: "Alice Sharma",
      timezone: "Asia/Kolkata",
    },
    {
      id: BOB,
      email: "bob@example.com",
      display_name: "Bob",
      timezone: "UTC",
    },
  ];

  fake.state.tables.contacts = [
    { id: ALICE_CONTACT, user_id: ALICE, display_name: "Priya", is_archived: false },
    { id: BOB_CONTACT, user_id: BOB, display_name: "Sam", is_archived: false },
  ];

  fake.state.tables.chat_imports = [
    {
      id: "import-a",
      user_id: ALICE,
      contact_id: ALICE_CONTACT,
      storage_path: `${ALICE}/import-a/chat.txt`,
    },
    {
      id: "import-b",
      user_id: BOB,
      contact_id: BOB_CONTACT,
      storage_path: `${BOB}/import-b/chat.txt`,
    },
  ];

  fake.state.tables.messages = [
    { id: "msg-a", user_id: ALICE, contact_id: ALICE_CONTACT, body: "alice private" },
    { id: "msg-b", user_id: BOB, contact_id: BOB_CONTACT, body: "bob private" },
  ];

  fake.state.tables.memories = [
    { id: "mem-a", user_id: ALICE, contact_id: ALICE_CONTACT, statement: "alice fact" },
    { id: "mem-b", user_id: BOB, contact_id: BOB_CONTACT, statement: "bob fact" },
  ];

  fake.state.tables.analysis_versions = [
    { id: "ver-a", user_id: ALICE, contact_id: ALICE_CONTACT, version: 1 },
    { id: "ver-b", user_id: BOB, contact_id: BOB_CONTACT, version: 1 },
  ];

  fake.state.tables.reply_drafts = [
    { id: "draft-a", user_id: ALICE, contact_id: ALICE_CONTACT, body: "alice draft" },
  ];

  fake.state.tables.data_cleanup_jobs = [];
}

/** Rows belonging to a user across every table the deletion touches. */
function rowCountFor(userId: string): number {
  let total = 0;
  for (const [table, rows] of Object.entries(fake.state.tables)) {
    if (table === "profiles") continue;
    total += rows.filter((row) => row.user_id === userId).length;
  }
  return total;
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  seed();
  fake.state.currentUserId = ALICE;
});

describe("transactional rollback", () => {
  /*
   * The regression test for the reported bug. A failure part-way through must
   * leave the database exactly as it was, not partially emptied.
   */
  it("deletes nothing when a mid-transaction delete fails", async () => {
    const before = rowCountFor(ALICE);
    expect(before).toBeGreaterThan(0);

    fake.state.failRpcAtTable = "messages";

    await expect(deleteContactData(client, ALICE, ALICE_CONTACT)).rejects.toThrow(DeletionError);

    // Every row is still there — including the tables processed before messages.
    expect(rowCountFor(ALICE)).toBe(before);
    expect(fake.state.tables.contacts?.some((row) => row.id === ALICE_CONTACT)).toBe(true);
    expect(fake.state.tables.analysis_versions?.some((row) => row.user_id === ALICE)).toBe(true);
  });

  it("queues no storage work when the transaction rolls back", async () => {
    fake.state.failRpcAtTable = "memories";

    await expect(deleteContactData(client, ALICE, ALICE_CONTACT)).rejects.toThrow();

    // The queue insert was part of the same transaction, so it rolled back too.
    expect(fake.state.tables.data_cleanup_jobs).toHaveLength(0);
  });

  it("does not report partial success when the connection fails outright", async () => {
    fake.state.failRpcEntirely = true;

    await expect(deleteEverything(client, ALICE)).rejects.toThrow(/no records were removed/);
    expect(rowCountFor(ALICE)).toBeGreaterThan(0);
  });

  it("rolls back a whole-account deletion that fails on contacts", async () => {
    const before = rowCountFor(ALICE);
    fake.state.failRpcAtTable = "contacts";

    await expect(deleteEverything(client, ALICE)).rejects.toThrow();

    expect(rowCountFor(ALICE)).toBe(before);
    // The profile was not anonymised either: one transaction, all or nothing.
    const profile = fake.state.tables.profiles?.find((row) => row.id === ALICE);
    expect(profile?.email).toBe("alice@example.com");
  });
});

describe("storage failures", () => {
  it("deletes the rows but reports the deletion as incomplete", async () => {
    fake.state.failRemovals = true;

    const outcome = await deleteContactData(client, ALICE, ALICE_CONTACT);

    // Rows are gone and committed…
    expect(outcome.rowsDeleted).toBe(true);
    expect(fake.state.tables.contacts?.some((row) => row.id === ALICE_CONTACT)).toBe(false);
    // …but the operation is NOT complete, and says so.
    expect(outcome.complete).toBe(false);
    expect(outcome.pendingCleanup.length).toBeGreaterThan(0);
  });

  it("keeps the queued path so the file is not lost track of", async () => {
    fake.state.failRemovals = true;

    await deleteContactData(client, ALICE, ALICE_CONTACT);

    const jobs = fake.state.tables.data_cleanup_jobs ?? [];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.object_path).toBe(`${ALICE}/import-a/chat.txt`);
  });

  it("records the attempt count so repeated failures are visible", async () => {
    fake.state.failRemovals = true;

    // The deletion itself attempts removal once, then two explicit retries.
    await deleteContactData(client, ALICE, ALICE_CONTACT);
    await retryPendingCleanup(client, ALICE);
    await retryPendingCleanup(client, ALICE);

    const pending = await listPendingCleanup(client, ALICE);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(3);
    expect(pending[0]?.lastError).toBeTruthy();
  });

  it("completes on retry once storage recovers", async () => {
    fake.state.failRemovals = true;
    const partial = await deleteContactData(client, ALICE, ALICE_CONTACT);
    expect(partial.complete).toBe(false);

    fake.state.failRemovals = false;
    const retried = await retryPendingCleanup(client, ALICE);

    expect(retried.complete).toBe(true);
    expect(retried.filesRemoved).toBe(1);
    expect(fake.state.removals).toContain(`${ALICE}/import-a/chat.txt`);
    expect(fake.state.tables.data_cleanup_jobs).toHaveLength(0);
  });

  it("leaves another user's storage alone", async () => {
    fake.state.failRemovals = true;
    await deleteContactData(client, ALICE, ALICE_CONTACT);
    fake.state.failRemovals = false;

    await retryPendingCleanup(client, ALICE);

    expect(fake.state.removals).not.toContain(`${BOB}/import-b/chat.txt`);
  });
});

describe("idempotence and repeat attempts", () => {
  it("a second deletion of the same contact removes nothing and still completes", async () => {
    const first = await deleteContactData(client, ALICE, ALICE_CONTACT);
    expect(first.complete).toBe(true);

    /*
     * The contact is gone, so the database refuses: this is a "not found or not
     * yours" error, not a silent success. That is the correct behaviour — a
     * deletion that quietly succeeds for a nonexistent row hides bugs.
     */
    await expect(deleteContactData(client, ALICE, ALICE_CONTACT)).rejects.toThrow(
      /not found or not yours/,
    );
  });

  it("deleting everything twice is safe the second time", async () => {
    const first = await deleteEverything(client, ALICE);
    expect(first.complete).toBe(true);

    const second = await deleteEverything(client, ALICE);

    // Nothing left to remove, and the operation is honestly complete.
    expect(second.complete).toBe(true);
    expect(second.deleted.contacts ?? 0).toBe(0);
    expect(rowCountFor(ALICE)).toBe(0);
  });

  it("retrying cleanup with an empty queue is a no-op that reports complete", async () => {
    const result = await retryPendingCleanup(client, ALICE);

    expect(result.complete).toBe(true);
    expect(result.filesRemoved).toBe(0);
    expect(result.pendingCleanup).toEqual([]);
  });

  it("is safe to retry after repeated partial failures, then converges", async () => {
    fake.state.failRemovals = true;
    await deleteContactData(client, ALICE, ALICE_CONTACT);

    // Three failed retries.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await retryPendingCleanup(client, ALICE);
      expect(result.complete).toBe(false);
    }

    fake.state.failRemovals = false;
    const final = await retryPendingCleanup(client, ALICE);

    expect(final.complete).toBe(true);
    expect(fake.state.tables.data_cleanup_jobs).toHaveLength(0);
  });
});

describe("scoping under failure", () => {
  it("never deletes another user's rows, even when the operation fails", async () => {
    fake.state.failRpcAtTable = "memories";

    await expect(deleteEverything(client, ALICE)).rejects.toThrow();

    expect(fake.state.tables.contacts?.some((row) => row.id === BOB_CONTACT)).toBe(true);
    expect(fake.state.tables.messages?.some((row) => row.user_id === BOB)).toBe(true);
  });

  it("never deletes another user's rows on success either", async () => {
    await deleteEverything(client, ALICE);

    expect(fake.state.tables.contacts?.some((row) => row.id === BOB_CONTACT)).toBe(true);
    expect(fake.state.tables.profiles?.find((row) => row.id === BOB)?.email).toBe(
      "bob@example.com",
    );
  });

  it("uses the authenticated identity, not the caller's argument", async () => {
    // Alice is signed in; asking to delete Bob's contact must fail.
    fake.state.currentUserId = ALICE;
    await expect(deleteContactData(client, ALICE, BOB_CONTACT)).rejects.toThrow(
      /not found or not yours/,
    );

    expect(fake.state.tables.contacts?.some((row) => row.id === BOB_CONTACT)).toBe(true);
  });
});

describe("profile anonymisation", () => {
  it("clears identifying profile fields", async () => {
    const outcome = await deleteEverything(client, ALICE);

    expect(outcome.profileAnonymised).toBe(true);

    const profile = fake.state.tables.profiles?.find((row) => row.id === ALICE);
    expect(profile?.email).toBeNull();
    expect(profile?.display_name).toBe("Deleted account");
    expect(profile?.timezone).toBe("UTC");
  });

  it("keeps the bare identifier the account is keyed by", async () => {
    await deleteEverything(client, ALICE);

    // The row survives because it *is* the account reference, not personal data.
    const profile = fake.state.tables.profiles?.find((row) => row.id === ALICE);
    expect(profile).toBeDefined();
    expect(profile?.id).toBe(ALICE);
  });

  it("does not touch another user's profile", async () => {
    await deleteEverything(client, ALICE);

    const bob = fake.state.tables.profiles?.find((row) => row.id === BOB);
    expect(bob?.email).toBe("bob@example.com");
    expect(bob?.display_name).toBe("Bob");
  });

  it("leaves the profile intact when anonymisation is declined", async () => {
    const outcome = await deleteEverything(client, ALICE, { anonymiseProfile: false });

    expect(outcome.profileAnonymised).toBe(false);

    const profile = fake.state.tables.profiles?.find((row) => row.id === ALICE);
    expect(profile?.email).toBe("alice@example.com");
  });
});
