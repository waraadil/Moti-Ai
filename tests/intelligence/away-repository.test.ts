/**
 * Away Mode persistence and service behaviour against the fake database.
 *
 * The pure rules are covered in `away.test.ts`. These tests cover what happens
 * when they meet storage: defaults on first read, tenant scoping, the approval
 * gate, and the append-only activity log.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "../helpers/fake-supabase";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  createPreparedReply,
  decidePreparedReply,
  getAwaySettings,
  listAwayEvents,
  listPendingReplies,
  recordAwayEvent,
  setContactPermission,
  clearContactPermission,
  listContactPermissions,
} from "@/server/away/repository";
import { checkPrepareAllowed, loadAwayOverview, saveAwaySettings } from "@/server/away/service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-11-06T12:00:00.000Z");

let fake: FakeSupabase;
let client: ServerSupabaseClient;

beforeEach(() => {
  fake = createFakeSupabase();
  client = fake as unknown as ServerSupabaseClient;
  fake.state.tables.contacts = [
    { id: CONTACT_ID, user_id: USER_ID, display_name: "Priya", is_archived: false },
  ];
});

describe("settings", () => {
  it("creates default settings on first read, with drafting off", async () => {
    const settings = await getAwaySettings(client, USER_ID);

    expect(settings.status).toBe("off");
    expect(settings.default_permission).toBe("draft_only");
    expect(settings.ends_at).toBeNull();
  });

  it("returns the same row on a second read rather than creating another", async () => {
    const first = await getAwaySettings(client, USER_ID);
    const second = await getAwaySettings(client, USER_ID);

    expect(second.id).toBe(first.id);
    expect(fake.state.tables.away_settings).toHaveLength(1);
  });

  it("saves a window and reports it as active", async () => {
    await getAwaySettings(client, USER_ID);

    const result = await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: "2026-11-06T09:00:00.000Z",
        endsAt: "2026-11-06T18:00:00.000Z",
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    expect(result.ok).toBe(true);

    const overview = await loadAwayOverview(client, USER_ID, NOW);
    expect(overview.state.effective).toBe("active");
    expect(overview.pendingCount).toBe(0);
  });

  it("refuses an end time before the start time", async () => {
    await getAwaySettings(client, USER_ID);

    const result = await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: "2026-11-06T18:00:00.000Z",
        endsAt: "2026-11-06T09:00:00.000Z",
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("after its start");
  });

  it("refuses a window that has already ended", async () => {
    await getAwaySettings(client, USER_ID);

    const result = await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: null,
        endsAt: "2026-11-05T09:00:00.000Z",
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("already ended");
  });

  it("refuses a scheduled status with no times at all", async () => {
    await getAwaySettings(client, USER_ID);

    const result = await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "scheduled",
        startsAt: null,
        endsAt: null,
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    expect(result.ok).toBe(false);
  });

  it("refuses an away message that promises automatic replies", async () => {
    await getAwaySettings(client, USER_ID);

    const result = await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: null,
        endsAt: null,
        awayMessage: "Auto-reply is on, I will respond automatically",
        defaultPermission: "draft_only",
      },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("cannot send messages");
  });
});

describe("activity log", () => {
  it("records enabling and disabling as real transitions", async () => {
    await getAwaySettings(client, USER_ID);

    await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: null,
        endsAt: null,
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "off",
        startsAt: null,
        endsAt: null,
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    const events = await listAwayEvents(client, USER_ID);
    const kinds = events.map((event) => event.kind);

    expect(kinds).toContain("mode_enabled");
    expect(kinds).toContain("mode_disabled");
  });

  it("does not log a change when the status is unchanged", async () => {
    await getAwaySettings(client, USER_ID);

    await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "off",
        startsAt: null,
        endsAt: null,
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    const events = await listAwayEvents(client, USER_ID);
    expect(events).toHaveLength(0);
  });

  it("keeps the log scoped to its owner", async () => {
    await recordAwayEvent(client, { userId: USER_ID, kind: "mode_enabled", detail: "mine" });
    await recordAwayEvent(client, { userId: OTHER_USER, kind: "mode_enabled", detail: "theirs" });

    const events = await listAwayEvents(client, USER_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toBe("mine");
  });
});

describe("per-contact permissions", () => {
  it("stores an override and reads it back by contact", async () => {
    await setContactPermission(client, USER_ID, CONTACT_ID, "silent");

    const map = await listContactPermissions(client, USER_ID);
    expect(map.get(CONTACT_ID)?.permission).toBe("silent");
  });

  it("replaces an existing override rather than duplicating it", async () => {
    await setContactPermission(client, USER_ID, CONTACT_ID, "silent");
    await setContactPermission(client, USER_ID, CONTACT_ID, "draft_only");

    const map = await listContactPermissions(client, USER_ID);
    expect(map.get(CONTACT_ID)?.permission).toBe("draft_only");
    expect(fake.state.tables.away_contact_permissions).toHaveLength(1);
  });

  it("clearing an override falls back to the default", async () => {
    await setContactPermission(client, USER_ID, CONTACT_ID, "silent");
    await clearContactPermission(client, USER_ID, CONTACT_ID);

    const map = await listContactPermissions(client, USER_ID);
    expect(map.size).toBe(0);
  });
});

describe("checkPrepareAllowed", () => {
  async function activate(overrides: { defaultPermission?: "draft_only" | "silent" } = {}) {
    await getAwaySettings(client, USER_ID);
    await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: null,
        endsAt: null,
        awayMessage: null,
        defaultPermission: overrides.defaultPermission ?? "draft_only",
      },
      NOW,
    );
  }

  it("refuses while Away Mode is off", async () => {
    const decision = await checkPrepareAllowed(client, USER_ID, CONTACT_ID, NOW);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("off");
  });

  it("allows drafts once away with the default permission", async () => {
    await activate();

    const decision = await checkPrepareAllowed(client, USER_ID, CONTACT_ID, NOW);
    expect(decision.allowed).toBe(true);
    expect(decision.permission).toBe("draft_only");
  });

  it("refuses a contact explicitly set to silent", async () => {
    await activate();
    await setContactPermission(client, USER_ID, CONTACT_ID, "silent");

    const decision = await checkPrepareAllowed(client, USER_ID, CONTACT_ID, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("silent");
  });

  it("refuses everyone when the default is silent", async () => {
    await activate({ defaultPermission: "silent" });

    const decision = await checkPrepareAllowed(client, USER_ID, CONTACT_ID, NOW);
    expect(decision.allowed).toBe(false);
  });

  it("refuses once the window has closed", async () => {
    await getAwaySettings(client, USER_ID);
    await saveAwaySettings(
      client,
      USER_ID,
      {
        status: "active",
        startsAt: "2026-11-06T09:00:00.000Z",
        endsAt: "2026-11-06T13:00:00.000Z",
        awayMessage: null,
        defaultPermission: "draft_only",
      },
      NOW,
    );

    const later = new Date("2026-11-06T14:00:00.000Z");
    const decision = await checkPrepareAllowed(client, USER_ID, CONTACT_ID, later);

    expect(decision.allowed).toBe(false);
  });
});

describe("prepared replies", () => {
  async function prepare(body = "kal baat karein?") {
    return createPreparedReply(client, {
      userId: USER_ID,
      contactId: CONTACT_ID,
      inReplyToMessageId: null,
      body,
      modelProvider: "deterministic",
      modelName: "moti-rules-v1",
      promptVersion: "test",
    });
  }

  it("always starts pending, whatever the caller wants", async () => {
    const reply = await prepare();
    expect(reply.state).toBe("pending");
    expect(reply.decided_at).toBeNull();
  });

  it("lists only pending replies as waiting for the user", async () => {
    const first = await prepare("one");
    await prepare("two");

    await decidePreparedReply(client, USER_ID, first.id, "approved");

    const pending = await listPendingReplies(client, USER_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toBe("two");
  });

  it("records the decision time when approved", async () => {
    const reply = await prepare();

    const decided = await decidePreparedReply(client, USER_ID, reply.id, "approved");
    expect(decided.state).toBe("approved");
    expect(decided.decided_at).not.toBeNull();
  });

  it("refuses to decide the same reply twice", async () => {
    const reply = await prepare();
    await decidePreparedReply(client, USER_ID, reply.id, "approved");

    await expect(
      decidePreparedReply(client, USER_ID, reply.id, "rejected"),
    ).rejects.toThrow(/no longer waiting/);
  });

  it("cannot be decided by another user", async () => {
    const reply = await prepare();

    await expect(
      decidePreparedReply(client, OTHER_USER, reply.id, "approved"),
    ).rejects.toThrow(/no longer waiting/);
  });

  it("appears in the overview pending count", async () => {
    await prepare();

    const overview = await loadAwayOverview(client, USER_ID, NOW);
    expect(overview.pendingCount).toBe(1);
  });
});
