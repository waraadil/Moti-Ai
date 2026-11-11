/**
 * Temporal diff persistence.
 *
 * The diff used to be computed and returned but never stored, so the contact
 * page could not show what changed between imports. These tests prove it is now
 * attached to the version that produced it, and that a first run has no diff.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { runAnalysis } from "@/server/analysis/pipeline";
import { recentTemporalChanges } from "@/server/analysis/repository";
import { DeterministicProvider } from "@/lib/ai/deterministic";
import type { ProviderBundle } from "@/lib/ai";
import {
  buildPriyaConversation,
  buildPriyaConversationExtended,
} from "../fixtures/conversations";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let fake: FakeSupabase;
let client: ServerSupabaseClient;
let provider: ProviderBundle;

function run(rows: ReturnType<typeof buildPriyaConversation>) {
  return runAnalysis({
    userId: USER_ID,
    contactId: CONTACT_ID,
    contactName: "Priya",
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

describe("temporal diff persistence", () => {
  it("stores no diff on a first run, because there is nothing to compare", async () => {
    const outcome = await run(buildPriyaConversation());

    expect(outcome.status).toBe("completed");

    const versions = fake.state.tables.analysis_versions ?? [];
    expect(versions).toHaveLength(1);
    // Null, not an empty array: "no previous analysis" differs from "no changes".
    expect(versions[0]?.temporal_diff ?? null).toBeNull();

    expect(await recentTemporalChanges(client, USER_ID, CONTACT_ID)).toBeNull();
  });

  it("stores the changes on the version produced by a later import", async () => {
    await run(buildPriyaConversation());
    const second = await run(buildPriyaConversationExtended());

    expect(second.status).toBe("completed");

    const versions = fake.state.tables.analysis_versions ?? [];
    const latest = versions.find((row) => row.version === 2);
    expect(latest).toBeDefined();

    const diff = latest?.temporal_diff as Array<{ kind: string; summary: string }> | null;
    expect(Array.isArray(diff)).toBe(true);
    expect(diff!.length).toBeGreaterThan(0);
    expect(diff!.some((change) => change.kind === "new_messages")).toBe(true);
  });

  it("keeps each version's own diff rather than overwriting history", async () => {
    await run(buildPriyaConversation());
    await run(buildPriyaConversationExtended());

    const versions = fake.state.tables.analysis_versions ?? [];
    const first = versions.find((row) => row.version === 1);
    const second = versions.find((row) => row.version === 2);

    expect(first?.temporal_diff ?? null).toBeNull();
    expect(second?.temporal_diff ?? null).not.toBeNull();
  });

  it("surfaces the newest non-empty diff for the contact page", async () => {
    await run(buildPriyaConversation());
    await run(buildPriyaConversationExtended());

    const recent = await recentTemporalChanges(client, USER_ID, CONTACT_ID);

    expect(recent).not.toBeNull();
    expect(recent!.version).toBe(2);
    expect(recent!.changes.length).toBeGreaterThan(0);
  });

  it("scopes the diff lookup to the owning user", async () => {
    await run(buildPriyaConversation());
    await run(buildPriyaConversationExtended());

    const other = await recentTemporalChanges(
      client,
      "22222222-2222-4222-8222-222222222222",
      CONTACT_ID,
    );
    expect(other).toBeNull();
  });
});
