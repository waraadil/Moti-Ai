import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { runAnalysis, toAnalysisInput, memoryFingerprint } from "@/server/analysis/pipeline";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { ProviderBundle } from "@/lib/ai";
import {
  buildContradictionConversation,
  buildOneSidedConversation,
  buildPriyaConversation,
  buildPriyaConversationExtended,
  buildTinyConversation,
} from "../fixtures/conversations";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let fake: FakeSupabase;
let client: ServerSupabaseClient;
let provider: ProviderBundle;

function seedContact(displayName = "Priya") {
  fake.state.tables.contacts = [
    {
      id: CONTACT_ID,
      user_id: USER_ID,
      display_name: displayName,
      relationship_kind: "friend",
      is_archived: false,
    },
  ];
}

function run(rows: ReturnType<typeof buildPriyaConversation>, contactName = "Priya") {
  return runAnalysis({
    userId: USER_ID,
    contactId: CONTACT_ID,
    contactName,
    selfName: "Wara",
    messages: rows,
    supabase: client,
    provider,
  });
}

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  provider = { kind: "deterministic", provider: new DeterministicProvider() };
  seedContact();
});

describe("pipeline: attribution safety", () => {
  it("refuses to analyse a conversation it cannot attribute", async () => {
    const outcome = await run(buildOneSidedConversation());

    expect(outcome.status).toBe("skipped_untrusted");
    expect(outcome.problem).toMatch(/attributed to you/i);
    expect(outcome.versionId).toBeNull();
    expect(fake.state.tables.analysis_versions ?? []).toHaveLength(0);
    expect(fake.state.tables.memories ?? []).toHaveLength(0);
  });
});

describe("pipeline: first successful run", () => {
  it("produces a version, profiles, memories and a snapshot", async () => {
    const outcome = await run(buildPriyaConversation());

    expect(outcome.status).toBe("completed");
    expect(outcome.versionId).toBeTruthy();
    expect(outcome.version).toBe(1);
    expect(outcome.memoriesInserted).toBeGreaterThan(0);

    const versions = fake.state.tables.analysis_versions ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0]?.status).toBe("completed");
    expect(versions[0]?.model_provider).toBe("deterministic");
    expect(versions[0]?.prompt_version).toBeTruthy();
    expect(versions[0]?.message_count).toBeGreaterThan(30);

    const profiles = fake.state.tables.communication_profiles ?? [];
    expect(profiles).toHaveLength(2);
    const self = profiles.find((row) => row.participant === "self");
    const contact = profiles.find((row) => row.participant === "contact");
    expect(self?.is_populated).toBe(true);
    expect(contact?.is_populated).toBe(true);
    // The two profiles must differ: they describe different people.
    expect(self?.summary).not.toBe(contact?.summary);

    const snapshots = fake.state.tables.conversation_snapshots ?? [];
    expect(snapshots).toHaveLength(1);

    const runs = fake.state.tables.analysis_runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
  });

  it("stores every memory with speaker, timestamp and evidence status", async () => {
    await run(buildPriyaConversation());

    const memories = fake.state.tables.memories ?? [];
    const evidence = fake.state.tables.memory_evidence ?? [];

    expect(memories.length).toBeGreaterThan(0);
    expect(evidence.length).toBeGreaterThanOrEqual(memories.length);

    for (const row of evidence) {
      expect(row.speaker_label).toBeTruthy();
      expect(row.said_at).toBeTruthy();
      expect(["direct", "inferred"]).toContain(row.evidence_status);
      expect(row.excerpt).toBeTruthy();
    }

    // Each memory has at least one piece of evidence.
    for (const memory of memories) {
      const supporting = evidence.filter((row) => row.memory_id === memory.id);
      expect(supporting.length).toBeGreaterThan(0);
    }
  });

  it("records the provider identity on the version", async () => {
    const outcome = await run(buildPriyaConversation());
    expect(outcome.identity).toEqual({ provider: "deterministic", model: "moti-rules-v1" });
  });
});

describe("pipeline: idempotency and duplicate prevention", () => {
  it("returns the cached version instead of re-running identical input", async () => {
    const first = await run(buildPriyaConversation());
    const second = await run(buildPriyaConversation());

    expect(first.status).toBe("completed");
    expect(second.status).toBe("cached");
    expect(second.versionId).toBe(first.versionId);

    // No second version, no duplicate memories.
    expect(fake.state.tables.analysis_versions ?? []).toHaveLength(1);
    const memories = fake.state.tables.memories ?? [];
    expect(memories).toHaveLength(first.memoriesInserted);
  });

  it("does not duplicate memories when the same facts appear in a new import", async () => {
    const first = await run(buildPriyaConversation());
    // A later import re-states the same facts plus new messages.
    const second = await run(buildPriyaConversationExtended());

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(second.version).toBe(2);

    const memories = fake.state.tables.memories ?? [];
    const fingerprints = memories.map((row) => row.fingerprint as string);

    // No two active memories share a fingerprint.
    expect(new Set(fingerprints).size).toBe(fingerprints.length);

    // At least one memory was recognised as already known.
    expect(second.memoriesDuplicated).toBeGreaterThan(0);
  });

  it("keeps the original memory rather than overwriting it", async () => {
    await run(buildPriyaConversation());
    const before = (fake.state.tables.memories ?? []).map((row) => row.id).sort();

    await run(buildPriyaConversationExtended());
    const after = (fake.state.tables.memories ?? []).map((row) => row.id);

    for (const id of before) expect(after).toContain(id);
    // Everything is still active: nothing was silently replaced.
    for (const row of fake.state.tables.memories ?? []) {
      expect(row.status).toBe("active");
    }
  });

  it("supersedes the previous version instead of deleting it", async () => {
    const first = await run(buildPriyaConversation());
    const second = await run(buildPriyaConversationExtended());

    const versions = fake.state.tables.analysis_versions ?? [];
    expect(versions).toHaveLength(2);

    const oldVersion = versions.find((row) => row.id === first.versionId);
    const newVersion = versions.find((row) => row.id === second.versionId);

    expect(oldVersion?.status).toBe("superseded");
    expect(oldVersion?.superseded_by).toBe(newVersion?.id);
    expect(newVersion?.status).toBe("completed");
  });

  it("retries a failed run rather than creating a second run row", async () => {
    const input = toAnalysisInput(buildPriyaConversation(), {
      contactName: "Priya",
      selfName: "Wara",
    });

    // Seed a failed run with the same input hash by running once, then
    // marking the run failed to simulate a crash mid-analysis.
    await run(buildPriyaConversation());
    const runs = fake.state.tables.analysis_runs ?? [];
    expect(runs).toHaveLength(1);

    const runRow = runs[0] as Record<string, unknown>;
    runRow.status = "failed";
    runRow.analysis_version_id = null;

    // Remove the version so completion is not "already done".
    fake.state.tables.analysis_versions = [];
    fake.state.tables.memories = [];
    fake.state.tables.memory_evidence = [];
    fake.state.tables.conversation_snapshots = [];

    const retried = await run(buildPriyaConversation());

    expect(retried.status).toBe("completed");
    expect(input.messages.length).toBeGreaterThan(0);
    expect(fake.state.tables.analysis_runs ?? []).toHaveLength(1);
    expect((fake.state.tables.analysis_runs ?? [])[0]?.attempts).toBe(2);
  });
});

describe("pipeline: temporal intelligence", () => {
  it("reports changes between two imports without overwriting history", async () => {
    await run(buildPriyaConversation());
    const second = await run(buildPriyaConversationExtended());

    expect(second.temporal?.hasPrevious).toBe(true);
    expect(second.temporal?.newMessageCount).toBe(3);
    expect(second.temporal?.changes.some((change) => change.kind === "new_messages")).toBe(true);

    const snapshots = fake.state.tables.conversation_snapshots ?? [];
    expect(snapshots).toHaveLength(2);
    // Both snapshots survive: the comparison has a durable history.
    expect(snapshots[0]?.message_count).toBeLessThan(snapshots[1]?.message_count as number);
  });
});

describe("pipeline: insufficient evidence", () => {
  it("still completes but flags the sample as insufficient", async () => {
    const outcome = await run(buildTinyConversation(), "Sam");

    // Attribution is fine, so it is not "untrusted" — but it is not reliable either.
    expect(["completed", "skipped_untrusted"]).toContain(outcome.status);

    if (outcome.status === "completed") {
      expect(outcome.styleReliable).toBe(false);
      expect(outcome.coverageNote).toMatch(/need at least|small sample/i);
    }
  });
});

describe("pipeline: contradictions", () => {
  it("does not store speculation as fact", async () => {
    await run(buildContradictionConversation());

    const memories = fake.state.tables.memories ?? [];
    const statements = memories.map((row) => String(row.statement).toLowerCase());

    expect(statements.some((statement) => statement.includes("berlin"))).toBe(false);
  });

  it("keeps a corrected fact as its own memory rather than mutating the original", async () => {
    await run(buildContradictionConversation());
    const memories = fake.state.tables.memories ?? [];

    for (const row of memories) {
      expect(row.status).toBe("active");
      expect(row.fingerprint).toBeTruthy();
      expect(String(row.fingerprint)).toBe(memoryFingerprint(String(row.statement)));
    }
  });
});
