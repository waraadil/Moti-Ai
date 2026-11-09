/**
 * Away Mode rules.
 *
 * Pure functions only: no database, no clock of their own, no network. Every
 * decision is a function of the values passed in, which is what makes the rules
 * testable and stops "is the user away?" from being answered differently in two
 * places.
 *
 * The hard constraint for this whole feature: **Moti cannot send messages.**
 * There is no outbound integration. Away Mode therefore decides only *whether a
 * draft may be prepared* and *what state that preparation is in*. It never
 * decides to contact anyone.
 */

export type AwayStatus = "active" | "scheduled" | "off";
export type AwayPermission = "draft_only" | "silent";

export type AwayWindow = {
  status: AwayStatus;
  startsAt: string | null;
  endsAt: string | null;
};

export type AwayState = {
  /** The stored status. */
  stored: AwayStatus;
  /**
   * What is actually true right now. Differs from `stored` when a scheduled
   * window has not opened yet or has already closed.
   */
  effective: AwayStatus;
  /** When the current or next window opens/closes, for the UI. */
  since: string | null;
  until: string | null;
  /** True when the window was left open-ended. */
  isOpenEnded: boolean;
};

/** Parses a timestamp, returning null for null/invalid rather than NaN. */
function parse(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Resolves what Away Mode is actually doing at `now`.
 *
 * A stored status of `scheduled` whose window has passed is reported as `off`,
 * not as `scheduled`: showing "you are away" when the window ended an hour ago
 * would be a lie, and would make the activity log misleading.
 */
export function resolveAwayState(window: AwayWindow, now: Date): AwayState {
  const nowMs = now.getTime();
  const startsAt = parse(window.startsAt);
  const endsAt = parse(window.endsAt);

  const base: Omit<AwayState, "effective"> = {
    stored: window.status,
    since: window.startsAt,
    until: window.endsAt,
    isOpenEnded: window.endsAt === null && window.status !== "off",
  };

  if (window.status === "off") {
    return { ...base, effective: "off" };
  }

  // A window that has already closed is not active, whatever the stored flag says.
  if (endsAt !== null && nowMs >= endsAt) {
    return { ...base, effective: "off" };
  }

  // A window that has not opened yet is scheduled, never active.
  if (startsAt !== null && nowMs < startsAt) {
    return { ...base, effective: "scheduled" };
  }

  return { ...base, effective: "active" };
}

/** Only an effective `active` window covers anyone. */
export function isCovering(state: AwayState): boolean {
  return state.effective === "active";
}

/**
 * Whether Moti may prepare a draft for this contact right now.
 *
 * Defaults are deliberately conservative: an unknown contact inherits the
 * user's default, and the schema default for that is `draft_only`, never
 * anything that would act on the user's behalf.
 */
export function mayPrepareDraft(params: {
  state: AwayState;
  contactPermission: AwayPermission | null;
  defaultPermission: AwayPermission;
}): { allowed: boolean; reason: string } {
  if (!isCovering(params.state)) {
    return {
      allowed: false,
      reason:
        params.state.effective === "scheduled"
          ? "Away Mode starts later; nothing is prepared before the window opens."
          : "Away Mode is off, so nothing is prepared automatically.",
    };
  }

  const permission = params.contactPermission ?? params.defaultPermission;

  if (permission === "silent") {
    return {
      allowed: false,
      reason: "This contact is set to silent, so Moti prepares nothing for them.",
    };
  }

  return { allowed: true, reason: "Away Mode is on and this contact allows drafts." };
}

/**
 * The disclosure text shown with a prepared reply.
 *
 * Phase 4 requires disclosure. The sentence is fixed and never generated,
 * because a model could phrase it in a way that implies the message was sent.
 */
export const AWAY_DISCLOSURE =
  "Prepared by Moti AI while you were away. Nothing has been sent — review it and send it yourself if you agree.";

/** What the user's own away message may say. Rejects anything implying auto-reply. */
const FORBIDDEN_IMPLICATIONS = [
  /\bauto[- ]?reply\b/i,
  /\bautomatically (reply|repl(y|ies)|respond)/i,
  /\bmy assistant will (reply|respond)\b/i,
  /\bthis (message|reply) was sent by\b/i,
  /\bsent automatically\b/i,
];

export type AwayMessageCheck = { ok: boolean; problem: string | null };

/**
 * Validates the away message the user wants to be shown when drafting.
 *
 * The app cannot send anything, so a message promising automatic replies would
 * mislead whoever reads it. Rejecting that phrasing is a correctness check, not
 * a style preference.
 */
export function validateAwayMessage(message: string | null): AwayMessageCheck {
  if (message === null) return { ok: true, problem: null };

  const trimmed = message.trim();
  if (trimmed.length === 0) return { ok: true, problem: null };

  if (trimmed.length > 280) {
    return { ok: false, problem: "Keep the away message under 280 characters." };
  }

  for (const pattern of FORBIDDEN_IMPLICATIONS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        problem:
          "Moti cannot send messages, so the away message must not promise automatic replies.",
      };
    }
  }

  return { ok: true, problem: null };
}

/** Normalises a stored window into a description the UI can render. */
export function describeAwayWindow(state: AwayState): string {
  if (state.effective === "off") {
    if (state.stored === "off") return "Away Mode is off.";
    return "Away Mode has ended.";
  }

  if (state.effective === "scheduled") {
    return state.since ? `Away Mode starts ${state.since}.` : "Away Mode starts soon.";
  }

  if (state.isOpenEnded) return "Away Mode is on until you turn it off.";
  return state.until ? `Away Mode is on until ${state.until}.` : "Away Mode is on.";
}
