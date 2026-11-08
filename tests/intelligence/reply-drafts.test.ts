import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  acceptDraft,
  discardDraft,
  editDraft,
  listDrafts,
  replaceOpenDrafts,
  type NewReplyDraft,
} from "@/server/replies/repository";
import { generateReplyDrafts } from "@/server/replies/generate";
import { runAnalysis } from "@/server/analysis/pipeline";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { ProviderBundle } from "@/lib/ai";
import { buildPriyaConversation } from "../fixtures/conversations";
import { NotFoundError } from "@/lib/errors";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let fake: FakeSupabase;
let client: ServerSupabaseClient;
let provider: ProviderBundle;

function draftInput(body: string, overrides: Partial<NewReplyDraft> = {}): NewReplyDraft {
  return {
    userId: USER_ID,
    contactId: CONTACT_ID,
    analysisVersionId: null,
    inReplyToMessageId: null,
    body,
    tone: "casual",
    usedMemoryIds: [],
    modelProvider: "deterministic",
    modelName: "moti-rules-v1",
    promptVersion: "test",
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  provider = { kind: "deterministic", provider: new DeterministicProvider() };
});

describe("reply draft lifecycle", () => {
  it("stores drafts as suggestions, never as sent messages", async () => {
    const stored = await replaceOpenDrafts(client, [
      draftInput("Sounds good 🙂"),
      draftInput("How did it go?"),
    ]);

    expect(stored).toHaveLength(2);
    for (const draft of stored) {
      expect(draft.status).toBe("draft");
      // A freshly stored suggestion has never been acted on.
      expect(draft.accepted_at ?? null).toBeNull();
      expect(draft.edited_body ?? null).toBeNull();
    }
  });

  it("discards the previous open draft set when regenerating", async () => {
    await replaceOpenDrafts(client, [draftInput("first suggestion")]);
    await replaceOpenDrafts(client, [draftInput("second suggestion")]);

    const open = await listDrafts(client, USER_ID, CONTACT_ID, { statuses: ["draft"] });
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe("second suggestion");

    // The superseded suggestion is retained as discarded, not deleted.
    const discarded = await listDrafts(client, USER_ID, CONTACT_ID, { statuses: ["discarded"] });
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.body).toBe("first suggestion");
  });

  it("never touches an accepted draft when a new set is generated", async () => {
    const [first] = await replaceOpenDrafts(client, [draftInput("accepted one")]);
    await acceptDraft(client, USER_ID, first!.id);

    await replaceOpenDrafts(client, [draftInput("new one")]);

    const accepted = await listDrafts(client, USER_ID, CONTACT_ID, { statuses: ["accepted"] });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.body).toBe("accepted one");
  });

  it("records acceptance with a timestamp", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("let's do 7pm")]);
    const accepted = await acceptDraft(client, USER_ID, draft!.id);

    expect(accepted.status).toBe("accepted");
    expect(accepted.accepted_at).toBeTruthy();
    expect(new Date(accepted.accepted_at as string).getTime()).toBeGreaterThan(0);
  });

  it("refuses to re-accept a draft that was already reviewed", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("hi")]);
    await acceptDraft(client, USER_ID, draft!.id);

    await expect(acceptDraft(client, USER_ID, draft!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps both the original and the user's edited version", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("Sounds good 🙂")]);
    const edited = await editDraft(client, USER_ID, draft!.id, "Sounds great, see you at 7");

    expect(edited.status).toBe("edited");
    expect(edited.body).toBe("Sounds good 🙂");
    expect(edited.edited_body).toBe("Sounds great, see you at 7");
    expect(edited.accepted_at).toBeTruthy();
  });

  it("rejects an empty edit and tells the user to discard instead", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("hello")]);
    await expect(editDraft(client, USER_ID, draft!.id, "   ")).rejects.toThrow(/discard/i);
  });

  it("rejects an over-long edit rather than truncating it silently", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("hello")]);
    await expect(editDraft(client, USER_ID, draft!.id, "x".repeat(4001))).rejects.toThrow(
      /too long/i,
    );
  });

  it("discards idempotently and refuses to discard an accepted draft", async () => {
    const [first] = await replaceOpenDrafts(client, [draftInput("one")]);
    await discardDraft(client, USER_ID, first!.id);
    // Re-discarding is a no-op, not an error.
    await expect(discardDraft(client, USER_ID, first!.id)).resolves.toBeUndefined();

    const [second] = await replaceOpenDrafts(client, [draftInput("two")]);
    await acceptDraft(client, USER_ID, second!.id);
    await expect(discardDraft(client, USER_ID, second!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("scopes every operation to the owning user", async () => {
    const [draft] = await replaceOpenDrafts(client, [draftInput("private")]);
    const otherUser = "22222222-2222-4222-8222-222222222222";

    await expect(acceptDraft(client, otherUser, draft!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(discardDraft(client, otherUser, draft!.id)).rejects.toBeInstanceOf(NotFoundError);

    const visible = await listDrafts(client, otherUser, CONTACT_ID, { statuses: ["draft"] });
    expect(visible).toEqual([]);
  });
});

describe("reply draft generation", () => {
  async function seedAnalysis() {
    fake.state.tables.contacts = [
      {
        id: CONTACT_ID,
        user_id: USER_ID,
        display_name: "Priya",
        relationship_kind: "friend",
        is_archived: false,
      },
    ];

    const rows = buildPriyaConversation();
    await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: rows,
      supabase: client,
      provider,
    });

    fake.state.tables.messages = rows.map((row) => ({
      ...row,
      user_id: USER_ID,
      contact_id: CONTACT_ID,
    }));
  }

  it("refuses to draft before the conversation has been analysed", async () => {
    fake.state.tables.messages = buildPriyaConversation().map((row) => ({
      ...row,
      user_id: USER_ID,
      contact_id: CONTACT_ID,
    }));

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider,
    });

    expect(result.status).toBe("no_analysis");
    expect(result.drafts).toBe(0);
  });

  it("generates drafts grounded in the analysis and stores them for review", async () => {
    await seedAnalysis();

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider,
    });

    expect(result.status).toBe("created");
    expect(result.drafts).toBeGreaterThan(0);

    const stored = fake.state.tables.reply_drafts ?? [];
    expect(stored.length).toBe(result.drafts);
    for (const row of stored) {
      expect(row.status).toBe("draft");
      // Provenance is recorded on every draft.
      expect(row.model_provider).toBe("deterministic");
      expect(row.prompt_version).toBeTruthy();
      // It answers a specific message.
      expect(row.in_reply_to_message_id).toBeTruthy();
    }
  });

  it("never stores a draft that contains a promise or invented feeling", async () => {
    await seedAnalysis();
    await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider,
    });

    const stored = fake.state.tables.reply_drafts ?? [];
    const forbidden = [/i promise/i, /i will/i, /i love you/i, /i miss you/i, /i'll definitely/i];

    for (const row of stored) {
      for (const pattern of forbidden) {
        expect(String(row.body)).not.toMatch(pattern);
      }
    }
  });

  it("reports having nothing to reply to when every message is outgoing", async () => {
    await seedAnalysis();
    // Corrupt the fixture so the contact never speaks.
    const messages = fake.state.tables.messages ?? [];
    for (const row of messages) {
      row.direction = "outgoing";
    }

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider,
    });

    expect(result.status).toBe("no_incoming");
    expect(result.drafts).toBe(0);
    expect(result.problem).toMatch(/no incoming messages/i);
  });

  it("drafts against the most recent incoming message even if you spoke last", async () => {
    await seedAnalysis();

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider,
    });

    expect(result.status).toBe("created");

    // The fixture ends with an outgoing message, so the answer must be anchored
    // to an incoming one, never to the user's own last line.
    const latestIncoming = [...(fake.state.tables.messages ?? [])]
      .filter((row) => row.direction === "incoming")
      .pop();

    const stored = fake.state.tables.reply_drafts ?? [];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]?.in_reply_to_message_id).toBe(latestIncoming?.id);
  });
});
