/**
 * Away Mode service.
 *
 * Combines the pure rules in `lib/intelligence/away.ts` with persistence. All
 * clock access happens here and is injectable, so tests never depend on the
 * real time.
 */

import "server-only";

import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { AwayPermission, AwaySettingsRow } from "@/lib/supabase/database.types";
import {
  describeAwayWindow,
  mayPrepareDraft,
  resolveAwayState,
  validateAwayMessage,
  type AwayState,
} from "@/lib/intelligence/away";
import {
  getAwaySettings,
  getContactPermission,
  listAwayEvents,
  listPendingReplies,
  recordAwayEvent,
  updateAwaySettings,
  type UpdateAwaySettingsInput,
} from "./repository";

export type AwayOverview = {
  settings: AwaySettingsRow;
  state: AwayState;
  summary: string;
  pendingCount: number;
};

/** Everything the Away Mode page needs, in one round of queries. */
export async function loadAwayOverview(
  supabase: ServerSupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<AwayOverview> {
  const settings = await getAwaySettings(supabase, userId);
  const state = resolveAwayState(
    { status: settings.status, startsAt: settings.starts_at, endsAt: settings.ends_at },
    now,
  );
  const pending = await listPendingReplies(supabase, userId);

  return {
    settings,
    state,
    summary: describeAwayWindow(state),
    pendingCount: pending.length,
  };
}

export type SaveAwayResult = { ok: true; settings: AwaySettingsRow } | { ok: false; problem: string };

/**
 * Saves the user's Away Mode configuration.
 *
 * Validates before writing: an away message that would mislead (promising
 * automatic replies) is refused, and a window whose end precedes its start is
 * refused rather than silently swapped.
 */
export async function saveAwaySettings(
  supabase: ServerSupabaseClient,
  userId: string,
  input: UpdateAwaySettingsInput,
  now: Date = new Date(),
): Promise<SaveAwayResult> {
  const messageCheck = validateAwayMessage(input.awayMessage);
  if (!messageCheck.ok) {
    return { ok: false, problem: messageCheck.problem ?? "That away message is not usable." };
  }

  if (input.startsAt && input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
    return { ok: false, problem: "The end of the window must be after its start." };
  }

  if (input.status === "scheduled" && !input.startsAt && !input.endsAt) {
    return {
      ok: false,
      problem: "A scheduled window needs a start or an end time.",
    };
  }

  if (input.status === "active" && input.endsAt && Date.parse(input.endsAt) <= now.getTime()) {
    return {
      ok: false,
      problem: "That window has already ended. Choose a later end time, or leave it open.",
    };
  }

  const before = await getAwaySettings(supabase, userId);
  const settings = await updateAwaySettings(supabase, userId, input);
  const after = resolveAwayState(
    { status: settings.status, startsAt: settings.starts_at, endsAt: settings.ends_at },
    now,
  );

  // Only log a real transition, so the history reflects what changed.
  if (before.status !== settings.status) {
    await recordAwayEvent(supabase, {
      userId,
      kind: after.effective === "off" ? "mode_disabled" : "mode_enabled",
      detail: describeAwayWindow(after),
      data: { previous: before.status, next: settings.status },
    });
  }

  return { ok: true, settings };
}

export type PrepareDecision = {
  allowed: boolean;
  reason: string;
  permission: AwayPermission;
};

/** Whether a draft may be prepared for this contact right now. */
export async function checkPrepareAllowed(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  now: Date = new Date(),
): Promise<PrepareDecision> {
  const settings = await getAwaySettings(supabase, userId);
  const override = await getContactPermission(supabase, userId, contactId);

  const state = resolveAwayState(
    { status: settings.status, startsAt: settings.starts_at, endsAt: settings.ends_at },
    now,
  );

  const decision = mayPrepareDraft({
    state,
    contactPermission: override?.permission ?? null,
    defaultPermission: settings.default_permission,
  });

  return {
    allowed: decision.allowed,
    reason: decision.reason,
    permission: override?.permission ?? settings.default_permission,
  };
}

/** Recent activity, newest first. */
export async function loadAwayActivity(supabase: ServerSupabaseClient, userId: string) {
  return listAwayEvents(supabase, userId);
}
