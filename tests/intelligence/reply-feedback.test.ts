/**
 * Reply learning loop.
 *
 * `ReplyFeedback` was declared but never loaded, so the generator ignored
 * everything the user did with previous suggestions and could re-offer a draft
 * they had already thrown away. These tests cover the loader, the prompt
 * guidance and the repeat suppression.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  isEmptyFeedback,
  loadReplyFeedback,
} from "@/server/replies/preferences";
import { buildReplyUserPrompt, type ReplyContext } from "@/lib/intelligence/reply";
import { generateReplyDrafts } from "@/server/replies/generate";
import { buildPriyaConversation } from "../fixtures/conversations";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { ProviderBundle } from "@/lib/ai";
import { styleFromFixture } from "./helpers/style-fixture";
import { createMockFetch, openAiResponse } from "../helpers/mock-provider";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let fake: FakeSupabase;
let client: ServerSupabaseClient;

function seedDraft(overrides: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    user_id: USER_ID,
    contact_id: CONTACT_ID,
    analysis_version_id: null,
    in_reply_to_message_id: null,
    status: "discarded",
    tone: null,
    body: "placeholder",
    edited_body: null,
    used_memory_ids: [],
    model_provider: "deterministic",
    model_name: "moti-rules-v1",
    prompt_version: "test",
    created_at: new Date().toISOString(),
    accepted_at: null,
    ...overrides,
  };
  fake.state.tables.reply_drafts = [...(fake.state.tables.reply_drafts ?? []), row];
  return row;
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  fake.state.tables.contacts = [
    { id: CONTACT_ID, user_id: USER_ID, display_name: "Priya", is_archived: false },
  ];
  fake.state.tables.reply_drafts = [];
});

describe("loadReplyFeedback", () => {
  it("returns empty buckets when nothing has been decided yet", async () => {
    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);

    expect(feedback).toEqual({ accepted: [], edited: [], rejected: [] });
    expect(isEmptyFeedback(feedback)).toBe(true);
  });

  it("collects accepted, edited and discarded drafts separately", async () => {
    seedDraft({ status: "accepted", body: "haan bilkul, kal milte hain", tone: "casual" });
    seedDraft({
      status: "edited",
      body: "yaar kal milte hain?",
      edited_body: "kal milte hain yaar?",
    });
    seedDraft({ status: "discarded", body: "I hope this message finds you well" });

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);

    expect(feedback.accepted).toHaveLength(1);
    expect(feedback.accepted[0]?.body).toBe("haan bilkul, kal milte hain");
    expect(feedback.accepted[0]?.tone).toBe("casual");

    expect(feedback.edited).toHaveLength(1);
    expect(feedback.edited[0]).toEqual({
      original: "yaar kal milte hain?",
      edited: "kal milte hain yaar?",
    });

    expect(feedback.rejected).toHaveLength(1);
    expect(feedback.rejected[0]?.body).toBe("I hope this message finds you well");

    expect(isEmptyFeedback(feedback)).toBe(false);
  });

  it("ignores drafts that are still open", async () => {
    seedDraft({ status: "draft", body: "not decided yet" });

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);
    expect(isEmptyFeedback(feedback)).toBe(true);
  });

  it("never mixes in another contact's feedback", async () => {
    seedDraft({
      status: "discarded",
      contact_id: "44444444-4444-4444-8444-444444444444",
      body: "someone else's conversation",
    });

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);
    expect(isEmptyFeedback(feedback)).toBe(true);
  });

  it("never mixes in another user's feedback", async () => {
    seedDraft({
      status: "discarded",
      user_id: "22222222-2222-4222-8222-222222222222",
      body: "another account's draft",
    });

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);
    expect(isEmptyFeedback(feedback)).toBe(true);
  });

  it("caps how many examples it carries, newest first", async () => {
    for (let index = 0; index < 9; index += 1) {
      seedDraft({
        status: "discarded",
        body: `draft ${index}`,
        created_at: new Date(Date.now() - index * 60_000).toISOString(),
      });
    }

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);
    expect(feedback.rejected).toHaveLength(5);
    expect(feedback.rejected[0]?.body).toBe("draft 0");
  });

  it("truncates a very long draft so one example cannot dominate", async () => {
    seedDraft({ status: "discarded", body: "x".repeat(1000) });

    const feedback = await loadReplyFeedback(client, USER_ID, CONTACT_ID);
    expect(feedback.rejected[0]!.body.length).toBeLessThanOrEqual(401);
    expect(feedback.rejected[0]!.body.endsWith("…")).toBe(true);
  });
});

describe("prompt guidance from feedback", () => {
  const baseContext: ReplyContext = {
    contactName: "Priya",
    selfName: "Wara",
    latestIncoming: null,
    recentMessages: [],
    selfStyle: styleFromFixture(),
    contactStyle: styleFromFixture(),
    openThreads: [],
    memories: [],
    tone: null,
  };

  it("adds no feedback section when there is no history", () => {
    const prompt = buildReplyUserPrompt(baseContext);

    expect(prompt).not.toContain("HOW THE USER REWROTE");
    expect(prompt).not.toContain("DRAFTS THE USER DISCARDED");
    expect(prompt).not.toContain("DRAFTS THE USER SENT UNCHANGED");
  });

  it("shows both sides of an edit, so the model learns the difference", () => {
    const prompt = buildReplyUserPrompt({
      ...baseContext,
      feedback: {
        accepted: [],
        edited: [{ original: "Dear Priya,", edited: "hey priya" }],
        rejected: [],
      },
    });

    expect(prompt).toContain("SUGGESTED: Dear Priya,");
    expect(prompt).toContain("SENT AS: hey priya");
  });

  it("lists discarded drafts as things not to repeat", () => {
    const prompt = buildReplyUserPrompt({
      ...baseContext,
      feedback: {
        accepted: [],
        edited: [],
        rejected: [{ body: "Per my last email" }],
      },
    });

    expect(prompt).toContain("DRAFTS THE USER DISCARDED");
    expect(prompt).toContain("Per my last email");
  });

  it("includes the tone of accepted drafts", () => {
    const prompt = buildReplyUserPrompt({
      ...baseContext,
      feedback: {
        accepted: [{ body: "haha yes", tone: "playful" }],
        edited: [],
        rejected: [],
      },
    });

    expect(prompt).toContain("haha yes (tone: playful)");
  });
});

describe("generation respects feedback", () => {
  /** The provider returns text, so the mocked payload must be a JSON string. */
  const modelOutput = (bodies: string[]) =>
    JSON.stringify({
      drafts: bodies.map((body) => ({
        body,
        tone: "casual",
        rationale: "matches the thread",
        usedMemoryIds: [],
      })),
    });

  function generative(fetchImpl: typeof fetch): ProviderBundle {
    return {
      kind: "generative",
      providerId: "openai",
      provider: new OpenAiCompatibleProvider({
        apiKey: "sk-test-" + "z".repeat(32),
        model: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        providerId: "openai",
        fetchImpl,
        maxAttempts: 1,
      }),
    };
  }

  /**
   * Runs analysis and stores the same messages in the fake table.
   * `runAnalysis` consumes rows in memory; the reply generator re-reads them
   * from the database, so both sides need the data.
   */
  async function analyse() {
    const { runAnalysis } = await import("@/server/analysis/pipeline");
    const rows = buildPriyaConversation();

    const result = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: rows,
      supabase: client,
      provider: { kind: "deterministic", provider: new DeterministicProvider() },
    });
    expect(result.status).toBe("completed");

    fake.state.tables.messages = rows.map((row) => ({
      ...row,
      user_id: USER_ID,
      contact_id: CONTACT_ID,
    }));
  }

  it("does not re-offer a draft the user discarded, keeping the rest", async () => {
    await analyse();

    seedDraft({ status: "discarded", body: "I hope this finds you well!" });

    const mock = createMockFetch([
      {
        kind: "json",
        body: openAiResponse(
          modelOutput(["I hope this finds you well!", "kal baat karein?"]),
        ),
      },
    ]);

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(result.status).toBe("created");
    // Only the un-discarded draft survives.
    expect(result.drafts).toBe(1);

    // The seeded discarded row is still in the table, so compare open drafts only.
    const open = (fake.state.tables.reply_drafts ?? []).filter((row) => row.status === "draft");
    const bodies = open.map((row) => String(row.body));
    expect(bodies).toEqual(["kal baat karein?"]);
    expect(bodies).not.toContain("I hope this finds you well!");
  });

  it("matches a discarded draft despite different spacing and case", async () => {
    await analyse();

    seedDraft({ status: "discarded", body: "Haan   BILKUL." });

    const mock = createMockFetch([
      { kind: "json", body: openAiResponse(modelOutput(["haan bilkul."])) },
    ]);

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(result.status).toBe("empty");
    expect(result.drafts).toBe(0);
  });

  it("sends the feedback to the model", async () => {
    await analyse();

    seedDraft({
      status: "edited",
      body: "Dear Priya, I hope you are well.",
      edited_body: "hey priya, kya haal?",
    });

    const mock = createMockFetch([
      { kind: "json", body: openAiResponse(modelOutput(["hey priya, kya haal?"])) },
    ]);

    await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    const body = JSON.stringify(mock.calls[0]?.body ?? null);
    expect(body).toContain("SUGGESTED: Dear Priya, I hope you are well.");
    expect(body).toContain("SENT AS: hey priya, kya haal?");
  });

  it("keeps drafting when feedback cannot be loaded", async () => {
    await analyse();

    /*
     * Fail only the feedback query, not the first query the generator makes.
     * Everything else must still work.
     */
    const original = client.from.bind(client);
    let failed = false;
    const spy = vi
      .spyOn(client, "from")
      .mockImplementation(((table: string) => {
        // Only the feedback read fails; storing the new drafts must still work.
        if (table === "reply_drafts" && !failed) {
          failed = true;
          throw new Error("network down");
        }
        return original(table as never);
      }) as never);

    const mock = createMockFetch([
      { kind: "json", body: openAiResponse(modelOutput(["theek hai, kal milte hain"])) },
    ]);

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    spy.mockRestore();

    // Preferences are an improvement, never a prerequisite.
    expect(result.status).toBe("created");
  });
});
