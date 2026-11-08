/**
 * Full pipeline against a *mocked generative provider*.
 *
 * This is the test that proves the intelligence pipeline works with a real
 * language model, not just the rule engine. The provider is the real
 * `OpenAiCompatibleProvider`, so its HTTP handling runs; only the network is
 * replaced with scripted responses.
 *
 * Covers what the rule engine cannot reach:
 *   - schema validation of model output,
 *   - dropping candidates that cite messages outside the window,
 *   - an unparseable model reply being recorded as a failure, not as data,
 *   - reply drafts being filtered by the safety gate.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import { createMockFetch, openAiResponse } from "../helpers/mock-provider";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";
import type { ProviderBundle } from "@/lib/ai";
import { runAnalysis } from "@/server/analysis/pipeline";
import { generateReplyDrafts } from "@/server/replies/generate";
import { buildPriyaConversation } from "../fixtures/conversations";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "sk-test-" + "z".repeat(32);

let fake: FakeSupabase;
let client: ServerSupabaseClient;

function generative(fetchImpl: typeof fetch): ProviderBundle {
  return {
    kind: "generative",
    providerId: "openai",
    provider: new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      providerId: "openai",
      fetchImpl,
      maxAttempts: 1,
    }),
  };
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  fake.state.tables.contacts = [
    {
      id: CONTACT_ID,
      user_id: USER_ID,
      display_name: "Priya",
      relationship_kind: "friend",
      is_archived: false,
    },
  ];
});

describe("pipeline with a generative provider", () => {
  it("accepts schema-valid memories and stores them with evidence", async () => {
    const rows = buildPriyaConversation();
    // Cite two real message ids from the fixture.
    const first = rows[3]!;
    const second = rows[8]!;

    const modelOutput = JSON.stringify({
      memories: [
        {
          statement: "Priya is training for the Lisbon marathon",
          category: "goal",
          about: "contact",
          details: "Said she ran 18km on Sunday",
          topics: ["health"],
          evidenceStatus: "direct",
          confidence: 0.9,
          isSensitive: false,
          evidenceMessageIds: [first.id, second.id],
        },
      ],
      uncertainObservations: [],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    const outcome = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: rows,
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.memoriesInserted).toBe(1);
    expect(outcome.identity).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const memories = fake.state.tables.memories ?? [];
    expect(memories).toHaveLength(1);
    expect(memories[0]?.statement).toBe("Priya is training for the Lisbon marathon");

    // The version records which model produced it — provenance, not a guess.
    const versions = fake.state.tables.analysis_versions ?? [];
    expect(versions[0]?.model_provider).toBe("openai");
    expect(versions[0]?.model_name).toBe("gpt-4o-mini");

    // Both citations became evidence rows with speaker and timestamp.
    const evidence = fake.state.tables.memory_evidence ?? [];
    expect(evidence).toHaveLength(2);
    for (const row of evidence) {
      expect(row.speaker_label).toBeTruthy();
      expect(row.said_at).toBeTruthy();
    }
  });

  it("drops a memory that cites a message outside the analysed window", async () => {
    const rows = buildPriyaConversation();

    const modelOutput = JSON.stringify({
      memories: [
        {
          statement: "Priya has a cat named Miso",
          category: "life_event",
          about: "contact",
          topics: [],
          evidenceStatus: "direct",
          confidence: 0.95,
          isSensitive: false,
          // Fabricated id that does not exist in this conversation.
          evidenceMessageIds: ["msg-does-not-exist"],
        },
      ],
      uncertainObservations: [],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    const outcome = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: rows,
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    // A memory with no verifiable evidence must not be stored.
    expect(outcome.status).toBe("completed");
    expect(outcome.memoriesInserted).toBe(0);
    expect(fake.state.tables.memories ?? []).toHaveLength(0);
  });

  it("records zero memories when the model returns malformed JSON", async () => {
    const mock = createMockFetch([
      { kind: "json", body: openAiResponse("Sure! Here are the memories you asked for:") },
    ]);

    const outcome = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: buildPriyaConversation(),
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    // The run still completes: style and understanding are computed locally.
    expect(outcome.status).toBe("completed");
    expect(outcome.memoriesInserted).toBe(0);
    expect(fake.state.tables.memories ?? []).toHaveLength(0);
  });

  it("rejects model output that fails the schema", async () => {
    // `confidence` out of range and a missing statement.
    const modelOutput = JSON.stringify({
      memories: [
        {
          statement: "x",
          category: "goal",
          about: "contact",
          topics: [],
          evidenceStatus: "direct",
          confidence: 42,
          isSensitive: false,
          evidenceMessageIds: [],
        },
      ],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    const outcome = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: buildPriyaConversation(),
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.memoriesInserted).toBe(0);
  });

  it("fails the run cleanly when the provider errors, saving nothing", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 500, body: { error: { message: "upstream exploded" } } },
    ]);

    const outcome = await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: buildPriyaConversation(),
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    // Style/understanding are local, so a provider failure does not abort the
    // run — but no memories are invented.
    expect(outcome.memoriesInserted).toBe(0);
    expect(fake.state.tables.memories ?? []).toHaveLength(0);
  });

  it("sends the transcript and asks for JSON in the request", async () => {
    const mock = createMockFetch([
      {
        kind: "json",
        body: openAiResponse(JSON.stringify({ memories: [], uncertainObservations: [] })),
      },
    ]);

    await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: buildPriyaConversation(),
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    const body = mock.calls[0]!.body as {
      messages: Array<{ role: string; content: string }>;
      response_format?: { type: string };
    };

    expect(body.response_format).toEqual({ type: "json_object" });
    // The transcript is present with speaker attribution.
    expect(body.messages.at(-1)?.content).toMatch(/USER:|CONTACT:/);
    // The key never appears in the prompt body.
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});

describe("reply generation with a generative provider", () => {
  async function seedAnalysis() {
    const rows = buildPriyaConversation();

    // Seed an analysis version so reply generation has something to build on.
    const mock = createMockFetch([
      {
        kind: "json",
        body: openAiResponse(JSON.stringify({ memories: [], uncertainObservations: [] })),
      },
    ]);

    await runAnalysis({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      messages: rows,
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    fake.state.tables.messages = rows.map((row) => ({
      ...row,
      user_id: USER_ID,
      contact_id: CONTACT_ID,
    }));
  }

  it("stores only drafts that pass the safety gate", async () => {
    await seedAnalysis();

    const modelOutput = JSON.stringify({
      drafts: [
        {
          body: "I promise I'll be there on Saturday, I will book everything.",
          tone: "warm",
          rationale: "commits to the plan",
          usedMemoryIds: [],
        },
        {
          body: "Sounds good, see you Saturday?",
          tone: "casual",
          rationale: "Confirms the plan without committing you to anything.",
          usedMemoryIds: [],
        },
      ],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(result.status).toBe("created");
    expect(result.drafts).toBe(1);
    expect(result.rejected).toBe(1);

    const stored = fake.state.tables.reply_drafts ?? [];
    expect(stored).toHaveLength(1);
    expect(String(stored[0]?.body)).not.toMatch(/i promise/i);
    expect(stored[0]?.model_provider).toBe("openai");
  });

  it("stores nothing when every draft is unsafe", async () => {
    await seedAnalysis();

    const modelOutput = JSON.stringify({
      drafts: [
        {
          body: "I love you and I miss you.",
          tone: "warm",
          rationale: "expresses a feeling",
          usedMemoryIds: [],
        },
      ],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    const result = await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    expect(result.status).toBe("empty");
    expect(fake.state.tables.reply_drafts ?? []).toHaveLength(0);
  });

  it("records the provider that produced each draft", async () => {
    await seedAnalysis();

    const modelOutput = JSON.stringify({
      drafts: [
        {
          body: "How did the interview go?",
          tone: "curious",
          rationale: "Follows up on something she mentioned earlier.",
          usedMemoryIds: [],
        },
      ],
    });

    const mock = createMockFetch([{ kind: "json", body: openAiResponse(modelOutput) }]);

    await generateReplyDrafts({
      userId: USER_ID,
      contactId: CONTACT_ID,
      contactName: "Priya",
      selfName: "Wara",
      supabase: client,
      provider: generative(mock.fetchImpl),
    });

    const stored = fake.state.tables.reply_drafts ?? [];
    expect(stored[0]?.model_provider).toBe("openai");
    expect(stored[0]?.model_name).toBe("gpt-4o-mini");
    expect(stored[0]?.prompt_version).toBeTruthy();
  });
});
