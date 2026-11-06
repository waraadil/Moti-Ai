import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "./helpers/fake-supabase";
import {
  confirmImportParticipants,
  discardImport,
  ingestWhatsAppExport,
} from "@/server/imports/ingest";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { importUploadMetaSchema } from "@/lib/validation/schemas";

/**
 * Regression tests for the import pipeline: duplicate handling, rejection of
 * unusable files, orphan cleanup, and the two-stage confirm-then-store flow.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";

const VALID_EXPORT = [
  "12/03/2024, 09:16 - Priya: Hey! Are we still on for Saturday?",
  "12/03/2024, 09:18 - You: Yes definitely.",
  "12/03/2024, 09:19 - Priya: Great",
].join("\n");

const NAMED_EXPORT = [
  "12/03/2024, 09:16 - Priya: Are you coming?",
  "12/03/2024, 09:17 - Wara: Yes",
  "12/03/2024, 09:18 - Priya: Perfect",
].join("\n");

const GROUP_EXPORT = [
  "12/03/2024, 09:16 - Priya: Anyone free?",
  "12/03/2024, 09:17 - You: I am in",
  "12/03/2024, 09:18 - Rohan: Me too",
].join("\n");

let fake: FakeSupabase;
let client: ServerSupabaseClient;

function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function seedContact() {
  fake.state.tables.contacts = [
    {
      id: CONTACT_ID,
      user_id: USER_ID,
      display_name: "Priya",
      is_archived: false,
      relationship_kind: "friend",
    },
  ];
}

async function ingest(
  content: string,
  overrides: Partial<Parameters<typeof ingestWhatsAppExport>[0]> = {},
) {
  const storagePath = `${USER_ID}/${IMPORT_ID}/chat.txt`;
  // Mirror the real action: the bytes are uploaded before ingest runs.
  const upload = await fake.storage
    .from("chat-imports")
    .upload(storagePath, new TextEncoder().encode(content));

  expect(upload.error).toBeNull();

  return ingestWhatsAppExport({
    userId: USER_ID,
    supabase: client,
    importId: IMPORT_ID,
    filename: "chat.txt",
    content,
    byteSize: content.length,
    checksum: checksumOf(content),
    storagePath,
    dateOrder: "DMY",
    ...overrides,
  });
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  seedContact();
});

describe("upload validation (priority 1)", () => {
  it("accepts a genuine .txt export", () => {
    const parsed = importUploadMetaSchema.safeParse({
      filename: "WhatsApp Chat with Priya.txt",
      byteSize: 1024,
      contactId: CONTACT_ID,
      dateOrder: "DMY",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects .zip uploads", () => {
    const parsed = importUploadMetaSchema.safeParse({
      filename: "WhatsApp Chat with Priya.zip",
      byteSize: 1024,
      contactId: CONTACT_ID,
      dateOrder: "DMY",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/\.zip archives are not supported/i);
  });

  it("rejects other extensions such as .csv or no extension", () => {
    for (const filename of ["chat.csv", "chat", "chat.txt.zip", "archive.rar"]) {
      const parsed = importUploadMetaSchema.safeParse({
        filename,
        byteSize: 10,
        contactId: CONTACT_ID,
        dateOrder: "DMY",
      });
      expect(parsed.success, filename).toBe(false);
    }
  });

  it("is case-insensitive about the .TXT extension", () => {
    const parsed = importUploadMetaSchema.safeParse({
      filename: "CHAT.TXT",
      byteSize: 10,
      contactId: CONTACT_ID,
      dateOrder: "DMY",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ingest: rejection paths", () => {
  it("rejects a file that parses into zero valid messages and never marks it completed", async () => {
    const notAnExport = "just some notes\nnothing that looks like a chat";

    const outcome = await ingest(notAnExport);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.code).toBe("no_valid_messages");
    expect(outcome.objectRemoved).toBe(true);

    // No import row at all: nothing to mark completed.
    expect(fake.state.tables.chat_imports ?? []).toHaveLength(0);
    expect(fake.state.removals).toContain(`${USER_ID}/${IMPORT_ID}/chat.txt`);
    expect(fake.state.objects.size).toBe(0);
  });

  it("rejects an empty file", async () => {
    const outcome = await ingest("");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.code).toBe("empty_file");
    expect(fake.state.tables.chat_imports ?? []).toHaveLength(0);
  });

  it("rejects a group export and cleans up the upload", async () => {
    const outcome = await ingest(GROUP_EXPORT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected rejection");
    expect(outcome.code).toBe("group_conversation");
    expect(outcome.objectRemoved).toBe(true);
    expect(fake.state.objects.size).toBe(0);
    expect(fake.state.tables.chat_imports ?? []).toHaveLength(0);
  });

  it("never writes messages during the first stage", async () => {
    const outcome = await ingest(VALID_EXPORT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.status).toBe("needs_review");
    expect(outcome.parse.storedMessages).toBe(0);
    expect(fake.state.tables.messages ?? []).toHaveLength(0);
    expect(outcome.chatImport.status).toBe("needs_review");
    expect(outcome.chatImport.completed_at).toBeNull();
  });
});

describe("ingest: duplicate detection and cleanup (priority 4)", () => {
  it("rejects a second upload of an identical file and removes the new object", async () => {
    const first = await ingest(VALID_EXPORT);
    expect(first.ok).toBe(true);

    const secondPath = `${USER_ID}/99999999-9999-4999-8999-999999999999/chat.txt`;
    await fake.storage
      .from("chat-imports")
      .upload(secondPath, new TextEncoder().encode(VALID_EXPORT));

    const second = await ingestWhatsAppExport({
      userId: USER_ID,
      supabase: client,
      importId: "99999999-9999-4999-8999-999999999999",
      filename: "chat.txt",
      content: VALID_EXPORT,
      byteSize: VALID_EXPORT.length,
      checksum: checksumOf(VALID_EXPORT),
      storagePath: secondPath,
      dateOrder: "DMY",
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected duplicate rejection");
    expect(second.code).toBe("duplicate");
    expect(second.duplicateOfImportId).toBe(IMPORT_ID);
    expect(second.objectRemoved).toBe(true);

    // Only the first import survives, and only its object.
    expect(fake.state.tables.chat_imports).toHaveLength(1);
    expect(fake.state.objects.has(secondPath)).toBe(false);
  });

  it("does not delete another user's object when rejecting a duplicate path", async () => {
    await ingest(VALID_EXPORT);

    const foreignPath = `someone-else/1234/chat.txt`;
    const outcome = await ingestWhatsAppExport({
      userId: USER_ID,
      supabase: client,
      importId: "88888888-8888-4888-8888-888888888888",
      filename: "chat.txt",
      content: VALID_EXPORT,
      byteSize: VALID_EXPORT.length,
      checksum: checksumOf(VALID_EXPORT),
      storagePath: foreignPath,
      dateOrder: "DMY",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected duplicate rejection");
    expect(outcome.objectRemoved).toBe(false);
    expect(fake.state.removals).not.toContain(foreignPath);
  });
});

describe("confirm stage (priorities 3 and 4)", () => {
  it("stores messages only after confirmation, with labels and timestamps preserved", async () => {
    const pending = await ingest(VALID_EXPORT);
    if (!pending.ok) throw new Error("expected acceptance");

    const result = await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["You"],
    });

    expect(result.storedMessages).toBe(3);
    expect(result.contactLabel).toBe("Priya");

    const messages = fake.state.tables.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(messages.every((row) => row.contact_id === CONTACT_ID)).toBe(true);

    // Original sender labels and timestamps survive untouched.
    const incoming = messages.find((row) => row.direction === "incoming");
    expect(incoming?.sender_label).toBe("Priya");
    expect(incoming?.sent_at).toBe("2024-03-12T09:16:00.000Z");

    const outgoing = messages.find((row) => row.direction === "outgoing");
    expect(outgoing?.sender_label).toBe("You");
    expect(outgoing?.sent_at).toBe("2024-03-12T09:18:00.000Z");

    const chatImport = fake.state.tables.chat_imports?.[0];
    expect(chatImport?.status).toBe("completed");
    expect(chatImport?.parsed_messages).toBe(3);
    expect(chatImport?.completed_at).toBeTruthy();
    expect(chatImport?.contact_id).toBe(CONTACT_ID);
  });

  it("works when the user's own name is their real display name", async () => {
    const pending = await ingest(NAMED_EXPORT);
    if (!pending.ok) throw new Error("expected acceptance");
    // No "You" in this export, so it must ask rather than assume.
    expect(pending.parse.selfLabelConfident).toBe(false);

    const result = await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["Wara"],
    });

    expect(result.storedMessages).toBe(3);
    expect(result.contactLabel).toBe("Priya");

    const messages = fake.state.tables.messages ?? [];
    expect(messages.filter((row) => row.direction === "outgoing")).toHaveLength(1);
    expect(messages.find((row) => row.direction === "outgoing")?.sender_label).toBe("Wara");
  });

  it("honours the date order chosen at upload", async () => {
    const mdyExport = ["03/12/2024, 09:16 - Priya: Hello", "03/12/2024, 09:17 - You: Hi"].join(
      "\n",
    );

    const pending = await ingestWhatsAppExport({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      filename: "chat.txt",
      content: mdyExport,
      byteSize: mdyExport.length,
      checksum: checksumOf(mdyExport),
      storagePath: `${USER_ID}/${IMPORT_ID}/chat.txt`,
      dateOrder: "MDY",
    });
    if (!pending.ok) throw new Error("expected acceptance");
    await fake.storage
      .from("chat-imports")
      .upload(`${USER_ID}/${IMPORT_ID}/chat.txt`, new TextEncoder().encode(mdyExport));

    await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["You"],
      dateOrder: "MDY",
    });

    const first = (fake.state.tables.messages ?? [])[0];
    // MDY: 03/12/2024 is 12 March. DMY would have made it 3 December.
    expect(first?.sent_at).toBe("2024-03-12T09:16:00.000Z");
  });

  it("reuses the upload's date order when confirmation omits it", async () => {
    const mdyExport = ["03/12/2024, 09:16 - Priya: Hello", "03/12/2024, 09:17 - You: Hi"].join(
      "\n",
    );

    const pending = await ingestWhatsAppExport({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      filename: "chat.txt",
      content: mdyExport,
      byteSize: mdyExport.length,
      checksum: checksumOf(mdyExport),
      storagePath: `${USER_ID}/${IMPORT_ID}/chat.txt`,
      dateOrder: "MDY",
    });
    if (!pending.ok) throw new Error("expected acceptance");
    await fake.storage
      .from("chat-imports")
      .upload(`${USER_ID}/${IMPORT_ID}/chat.txt`, new TextEncoder().encode(mdyExport));

    // No dateOrder passed: it must be recovered from the parked import.
    await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["You"],
    });

    const first = (fake.state.tables.messages ?? [])[0];
    expect(first?.sent_at).toBe("2024-03-12T09:16:00.000Z");
  });

  it("refuses to confirm an import twice", async () => {
    await ingest(VALID_EXPORT);
    await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["You"],
    });

    await expect(
      confirmImportParticipants({
        userId: USER_ID,
        supabase: client,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        selfLabels: ["You"],
      }),
    ).rejects.toThrow(/already been confirmed/i);
  });

  it("rejects a self label that is not in the export", async () => {
    await ingest(VALID_EXPORT);

    await expect(
      confirmImportParticipants({
        userId: USER_ID,
        supabase: client,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        selfLabels: ["Someone Else"],
      }),
    ).rejects.toThrow(/is not one of the participants/i);
  });

  it("rejects selecting every participant as yourself", async () => {
    await ingest(VALID_EXPORT);

    await expect(
      confirmImportParticipants({
        userId: USER_ID,
        supabase: client,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        selfLabels: ["You", "Priya"],
      }),
    ).rejects.toThrow(/cannot be you/i);
  });

  it("marks the import failed and stores nothing when the file cannot be read back", async () => {
    const pending = await ingest(VALID_EXPORT);
    if (!pending.ok) throw new Error("expected acceptance");

    fake.state.failDownloadPaths.add(`${USER_ID}/${IMPORT_ID}/chat.txt`);

    await expect(
      confirmImportParticipants({
        userId: USER_ID,
        supabase: client,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        selfLabels: ["You"],
      }),
    ).rejects.toThrow(/could not be read back/i);

    expect(fake.state.tables.messages ?? []).toHaveLength(0);

    const chatImport = fake.state.tables.chat_imports?.[0];
    expect(chatImport?.status).toBe("failed");
    expect(chatImport?.completed_at).toBeNull();
    expect(chatImport?.parsed_messages).toBe(0);
    expect(String(chatImport?.error_message)).toMatch(/could not read the stored export back/i);
  });
});

describe("discard (priority 4)", () => {
  it("removes a parked import and its stored file", async () => {
    await ingest(VALID_EXPORT);

    const result = await discardImport({ userId: USER_ID, supabase: client, importId: IMPORT_ID });

    expect(result.objectRemoved).toBe(true);
    expect(fake.state.tables.chat_imports ?? []).toHaveLength(0);
    expect(fake.state.objects.size).toBe(0);
  });

  it("refuses to discard an import that already has stored messages", async () => {
    await ingest(VALID_EXPORT);
    await confirmImportParticipants({
      userId: USER_ID,
      supabase: client,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      selfLabels: ["You"],
    });

    await expect(
      discardImport({ userId: USER_ID, supabase: client, importId: IMPORT_ID }),
    ).rejects.toThrow(/already has stored messages/i);
  });
});
