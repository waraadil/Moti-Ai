/**
 * Data export and deletion.
 *
 * Scoping is the whole point of these modules: a single missing `user_id`
 * filter turns one person's deletion into another's data loss, and a missing
 * filter on export turns a download into a data breach. The tests below assert
 * the negative case explicitly — another user's rows must survive untouched.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { buildUserExport, exportFilename } from "@/server/data/export";
import {
  deleteContactData,
  deleteEverything,
  DeletionError,
} from "@/server/data/deletion";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ALICE_CONTACT = "33333333-3333-4333-8333-333333333333";
const BOB_CONTACT = "44444444-4444-4444-8444-444444444444";

let fake: FakeSupabase;
let client: ServerSupabaseClient;

function seed() {
  fake.state.tables.profiles = [
    { id: ALICE, email: "alice@example.com", display_name: "Alice" },
    { id: BOB, email: "bob@example.com", display_name: "Bob" },
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
      original_filename: "chat.txt",
    },
    {
      id: "import-b",
      user_id: BOB,
      contact_id: BOB_CONTACT,
      storage_path: `${BOB}/import-b/chat.txt`,
      original_filename: "chat.txt",
    },
  ];

  fake.state.tables.messages = [
    {
      id: "msg-a",
      user_id: ALICE,
      contact_id: ALICE_CONTACT,
      body: "alice private message",
      sender_label: "Priya",
    },
    {
      id: "msg-b",
      user_id: BOB,
      contact_id: BOB_CONTACT,
      body: "bob private message",
      sender_label: "Sam",
    },
  ];

  fake.state.tables.memories = [
    { id: "mem-a", user_id: ALICE, contact_id: ALICE_CONTACT, statement: "alice fact" },
    { id: "mem-b", user_id: BOB, contact_id: BOB_CONTACT, statement: "bob fact" },
  ];

  fake.state.tables.reply_drafts = [
    { id: "draft-a", user_id: ALICE, contact_id: ALICE_CONTACT, body: "alice draft" },
    { id: "draft-b", user_id: BOB, contact_id: BOB_CONTACT, body: "bob draft" },
  ];

  fake.state.tables.away_events = [
    { id: "ev-a", user_id: ALICE, contact_id: ALICE_CONTACT, kind: "mode_enabled" },
    { id: "ev-b", user_id: BOB, contact_id: BOB_CONTACT, kind: "mode_enabled" },
  ];
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  seed();
  // The deletion RPCs read identity from auth.uid(); the fake mirrors that.
  fake.state.currentUserId = ALICE;
});

describe("export", () => {
  it("includes only the caller's rows", async () => {
    const exported = await buildUserExport(client, ALICE);

    const messageBodies = JSON.stringify(exported.messages);
    expect(messageBodies).toContain("alice private message");
    expect(messageBodies).not.toContain("bob private message");
  });

  it("includes the profile but no other user's profile", async () => {
    const exported = await buildUserExport(client, ALICE);

    expect(exported.profile).toMatchObject({ email: "alice@example.com" });
    expect(JSON.stringify(exported.profile)).not.toContain("bob@example.com");
  });

  it("reports honest counts", async () => {
    const exported = await buildUserExport(client, ALICE);

    expect(exported.counts.contacts).toBe(1);
    expect(exported.counts.messages).toBe(1);
    expect(exported.counts.imports).toBe(1);
    expect(exported.counts.memories).toBe(1);
    expect(exported.counts.replyDrafts).toBe(1);
  });

  it("never includes secrets", async () => {
    const serialised = JSON.stringify(await buildUserExport(client, ALICE));

    expect(serialised).not.toMatch(/sk-[a-z0-9]{10,}/i);
    expect(serialised).not.toContain("SERVICE_ROLE");
    expect(serialised).not.toContain("API_KEY");
  });

  it("carries a note that no sent-message history exists", async () => {
    const exported = await buildUserExport(client, ALICE);
    expect(exported.meta.note).toContain("never sends messages");
  });

  it("returns empty sections rather than omitting them", async () => {
    const exported = await buildUserExport(client, "99999999-9999-4999-8999-999999999999");

    expect(exported.messages).toEqual([]);
    expect(exported.memories).toEqual([]);
    expect(exported.profile).toBeNull();
  });

  it("names the file by date", () => {
    expect(exportFilename(new Date("2026-11-06T12:00:00.000Z"))).toBe(
      "moti-ai-export-2026-11-06.json",
    );
  });
});

describe("deleteContactData", () => {
  it("removes the contact and everything derived from it", async () => {
    const report = await deleteContactData(client, ALICE, ALICE_CONTACT);

    expect(report.rowsDeleted).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.deleted.contacts).toBe(1);
    expect(fake.state.tables.messages?.some((row) => row.user_id === ALICE)).toBe(false);
    expect(fake.state.tables.contacts?.some((row) => row.id === ALICE_CONTACT)).toBe(false);
  });

  it("leaves another user's data completely untouched", async () => {
    await deleteContactData(client, ALICE, ALICE_CONTACT);

    expect(fake.state.tables.contacts?.some((row) => row.id === BOB_CONTACT)).toBe(true);
    expect(fake.state.tables.messages?.some((row) => row.user_id === BOB)).toBe(true);
    expect(fake.state.tables.memories?.some((row) => row.user_id === BOB)).toBe(true);
  });

  it("removes the stored export file", async () => {
    const report = await deleteContactData(client, ALICE, ALICE_CONTACT);

    expect(report.filesRemoved).toBe(1);
    expect(report.complete).toBe(true);
    expect(fake.state.removals).toContain(`${ALICE}/import-a/chat.txt`);
  });

  it("refuses to delete a contact owned by someone else", async () => {
    await expect(deleteContactData(client, ALICE, BOB_CONTACT)).rejects.toThrow(DeletionError);

    // Bob's contact is still there, and so are Alice's rows.
    expect(fake.state.tables.contacts?.some((row) => row.id === BOB_CONTACT)).toBe(true);
    expect(fake.state.tables.contacts?.some((row) => row.id === ALICE_CONTACT)).toBe(true);
  });

  /*
   * Storage cannot join a database transaction, so the rows do commit. The
   * guarantee moved: the deletion is now reported as INCOMPLETE and the file
   * path is kept in a retryable queue, rather than pretending either that
   * nothing happened or that everything finished.
   */
  it("reports an incomplete deletion when the stored file cannot be removed", async () => {
    fake.state.failRemovals = true;

    const report = await deleteContactData(client, ALICE, ALICE_CONTACT);

    expect(report.rowsDeleted).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.pendingCleanup).toHaveLength(1);
    expect(fake.state.tables.data_cleanup_jobs).toHaveLength(1);
  });
});

describe("deleteEverything", () => {
  it("removes all of one user's data", async () => {
    const report = await deleteEverything(client, ALICE);

    expect(Object.keys(report.deleted).length).toBeGreaterThan(0);
    expect(fake.state.tables.contacts?.some((row) => row.user_id === ALICE)).toBe(false);
    expect(fake.state.tables.messages?.some((row) => row.user_id === ALICE)).toBe(false);
    expect(fake.state.tables.memories?.some((row) => row.user_id === ALICE)).toBe(false);
    expect(fake.state.tables.reply_drafts?.some((row) => row.user_id === ALICE)).toBe(false);
    expect(fake.state.tables.away_events?.some((row) => row.user_id === ALICE)).toBe(false);
  });

  it("leaves every other user intact", async () => {
    await deleteEverything(client, ALICE);

    expect(fake.state.tables.contacts?.some((row) => row.user_id === BOB)).toBe(true);
    expect(fake.state.tables.messages?.some((row) => row.user_id === BOB)).toBe(true);
    expect(fake.state.tables.memories?.some((row) => row.user_id === BOB)).toBe(true);
  });

  it("keeps the profile row but clears its identifying fields", async () => {
    await deleteEverything(client, ALICE);

    const profile = fake.state.tables.profiles?.find((row) => row.id === ALICE);
    // The row is the account reference; the personal content in it is gone.
    expect(profile).toBeDefined();
    expect(profile?.email).toBeNull();
    expect(profile?.display_name).toBe("Deleted account");
  });

  it("removes every stored file the user owns", async () => {
    const report = await deleteEverything(client, ALICE);

    expect(report.filesRemoved).toBe(1);
    expect(fake.state.removals).toContain(`${ALICE}/import-a/chat.txt`);
    expect(fake.state.removals).not.toContain(`${BOB}/import-b/chat.txt`);
  });
});
