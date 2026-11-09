/**
 * Away Mode rules.
 *
 * The most important assertions here are negative ones: that a window which has
 * ended never reports as active, that a silent contact is never covered, and that
 * the app rejects away messages promising automatic replies — because it has no
 * way to send anything and must not imply otherwise.
 */

import { describe, expect, it } from "vitest";
import {
  AWAY_DISCLOSURE,
  describeAwayWindow,
  isCovering,
  mayPrepareDraft,
  resolveAwayState,
  validateAwayMessage,
  type AwayState,
  type AwayWindow,
} from "@/lib/intelligence/away";

const NOW = new Date("2026-11-06T12:00:00.000Z");

function state(overrides: Partial<AwayState> = {}): AwayState {
  return {
    stored: "active",
    effective: "active",
    since: null,
    until: null,
    isOpenEnded: true,
    ...overrides,
  };
}

describe("resolveAwayState", () => {
  it("reports off when Away Mode is off, whatever the window says", () => {
    const window: AwayWindow = {
      status: "off",
      startsAt: "2026-11-01T00:00:00.000Z",
      endsAt: "2026-11-30T00:00:00.000Z",
    };

    const resolved = resolveAwayState(window, NOW);
    expect(resolved.effective).toBe("off");
    expect(isCovering(resolved)).toBe(false);
  });

  it("reports active while inside an open window", () => {
    const resolved = resolveAwayState(
      {
        status: "active",
        startsAt: "2026-11-06T09:00:00.000Z",
        endsAt: "2026-11-06T18:00:00.000Z",
      },
      NOW,
    );

    expect(resolved.effective).toBe("active");
    expect(isCovering(resolved)).toBe(true);
    expect(resolved.isOpenEnded).toBe(false);
  });

  it("reports off once the window has ended, even if still flagged active", () => {
    const resolved = resolveAwayState(
      {
        status: "active",
        startsAt: "2026-11-01T09:00:00.000Z",
        endsAt: "2026-11-02T18:00:00.000Z",
      },
      NOW,
    );

    // This is the honesty case: a stale flag must not claim you are away.
    expect(resolved.effective).toBe("off");
    expect(isCovering(resolved)).toBe(false);
  });

  it("reports off at the exact end instant", () => {
    const resolved = resolveAwayState(
      { status: "active", startsAt: null, endsAt: NOW.toISOString() },
      NOW,
    );
    expect(resolved.effective).toBe("off");
  });

  it("reports scheduled before the window opens", () => {
    const resolved = resolveAwayState(
      {
        status: "scheduled",
        startsAt: "2026-11-10T09:00:00.000Z",
        endsAt: "2026-11-12T18:00:00.000Z",
      },
      NOW,
    );

    expect(resolved.effective).toBe("scheduled");
    expect(isCovering(resolved)).toBe(false);
  });

  it("treats an open-ended active window as active", () => {
    const resolved = resolveAwayState(
      { status: "active", startsAt: null, endsAt: null },
      NOW,
    );

    expect(resolved.effective).toBe("active");
    expect(resolved.isOpenEnded).toBe(true);
  });

  it("ignores an unparseable timestamp instead of throwing", () => {
    const resolved = resolveAwayState(
      { status: "active", startsAt: "not a date", endsAt: null },
      NOW,
    );
    expect(resolved.effective).toBe("active");
  });
});

describe("mayPrepareDraft", () => {
  it("refuses when Away Mode is off", () => {
    const decision = mayPrepareDraft({
      state: state({ stored: "off", effective: "off", isOpenEnded: false }),
      contactPermission: null,
      defaultPermission: "draft_only",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("off");
  });

  it("refuses before a scheduled window opens", () => {
    const decision = mayPrepareDraft({
      state: state({ stored: "scheduled", effective: "scheduled", isOpenEnded: false }),
      contactPermission: null,
      defaultPermission: "draft_only",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("starts later");
  });

  it("allows drafts for a contact with no override when the default permits", () => {
    const decision = mayPrepareDraft({
      state: state(),
      contactPermission: null,
      defaultPermission: "draft_only",
    });

    expect(decision.allowed).toBe(true);
  });

  it("refuses for a silent contact even when the default would allow", () => {
    const decision = mayPrepareDraft({
      state: state(),
      contactPermission: "silent",
      defaultPermission: "draft_only",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("silent");
  });

  it("honours a per-contact override that is more permissive than the default", () => {
    const decision = mayPrepareDraft({
      state: state(),
      contactPermission: "draft_only",
      defaultPermission: "silent",
    });

    expect(decision.allowed).toBe(true);
  });

  it("refuses everything when the default is silent and there is no override", () => {
    const decision = mayPrepareDraft({
      state: state(),
      contactPermission: null,
      defaultPermission: "silent",
    });

    expect(decision.allowed).toBe(false);
  });
});

describe("validateAwayMessage", () => {
  it("accepts silence and ordinary wording", () => {
    expect(validateAwayMessage(null).ok).toBe(true);
    expect(validateAwayMessage("").ok).toBe(true);
    expect(validateAwayMessage("Travelling today, will reply when I can.").ok).toBe(true);
  });

  it("rejects an over-long message", () => {
    const result = validateAwayMessage("x".repeat(281));
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("280");
  });

  // The app cannot send anything, so any of these would be a lie to the reader.
  it.each([
    "I have an auto-reply set up",
    "Auto reply is on",
    "This will automatically reply for me",
    "My assistant will reply shortly",
    "This message was sent by my assistant",
    "Replies are sent automatically",
  ])("rejects wording that promises automation: %s", (message) => {
    const result = validateAwayMessage(message);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("cannot send messages");
  });
});

describe("describeAwayWindow", () => {
  it("says off when off", () => {
    expect(describeAwayWindow(state({ stored: "off", effective: "off" }))).toBe(
      "Away Mode is off.",
    );
  });

  it("says ended when a stale active window has passed", () => {
    expect(describeAwayWindow(state({ stored: "active", effective: "off" }))).toBe(
      "Away Mode has ended.",
    );
  });

  it("describes an open-ended window honestly", () => {
    expect(describeAwayWindow(state())).toBe("Away Mode is on until you turn it off.");
  });

  it("includes the end time when there is one", () => {
    const summary = describeAwayWindow(
      state({ until: "2026-11-06T18:00:00.000Z", isOpenEnded: false }),
    );
    expect(summary).toContain("2026-11-06T18:00:00.000Z");
  });
});

describe("disclosure text", () => {
  it("states that nothing has been sent", () => {
    expect(AWAY_DISCLOSURE).toContain("Nothing has been sent");
    expect(AWAY_DISCLOSURE).toContain("Moti AI");
  });
});
