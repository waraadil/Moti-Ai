import { describe, expect, it } from "vitest";
import { resolveParticipants, splitByParticipant } from "@/lib/intelligence/participants";
import { buildOneSidedConversation, buildPriyaConversation } from "../fixtures/conversations";
import { toAnalysisInput } from "@/server/analysis/pipeline";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

describe("participant resolution", () => {
  it("derives the mapping from confirmed directions rather than guessing", () => {
    const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
    const resolution = resolveParticipants(input);

    expect(resolution.isUsable).toBe(true);
    expect(resolution.selfLabels).toEqual(["Wara"]);
    expect(resolution.contactLabel).toBe("Priya");
    expect(resolution.unmappedLabels).toEqual([]);
    expect(resolution.problem).toBeNull();
  });

  it("refuses analysis when the same label appears on both sides", () => {
    const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
    // Simulate a corrupt import where Priya's rows were marked outgoing.
    const corrupted = {
      ...input,
      messages: input.messages.map((message, index) =>
        index === 1 ? { ...message, participant: "self" as const, senderLabel: "Priya" } : message,
      ),
    };

    const resolution = resolveParticipants(corrupted);

    expect(resolution.isUsable).toBe(false);
    expect(resolution.problem).toMatch(/appears on both sides/i);
    expect(resolution.contactLabel).toBeNull();
  });

  it("refuses analysis when everything is attributed to the user", () => {
    const input = toAnalysisInput(buildOneSidedConversation(), {
      contactName: "Sam",
      selfName: "Wara",
    });
    const resolution = resolveParticipants(input);

    expect(resolution.isUsable).toBe(false);
    expect(resolution.problem).toMatch(/every stored message is attributed to you/i);
  });

  it("refuses analysis when messages map to more than one contact", () => {
    const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
    const multi = {
      ...input,
      messages: [
        ...input.messages,
        {
          ...(input.messages[0] as (typeof input.messages)[number]),
          participant: "contact" as const,
          senderLabel: "Someone Else",
        },
      ],
    };

    const resolution = resolveParticipants(multi);

    expect(resolution.isUsable).toBe(false);
    expect(resolution.problem).toMatch(/more than one|different people/i);
  });

  it("never attributes system rows to either participant", () => {
    const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
    const split = splitByParticipant(input.messages);

    for (const message of [...split.self, ...split.contact]) {
      expect(message.participant).not.toBe("system");
      expect(message.body.length).toBeGreaterThan(0);
    }

    // Every message lands on exactly one side.
    expect(split.self.length + split.contact.length).toBe(
      input.messages.filter((message) => message.kind === "text" && message.body.trim()).length,
    );
  });

  it("uses the direction column, not the sender label, for attribution", () => {
    // A message whose label looks like the contact but which the import marked
    // as outgoing must stay with the user; the label is metadata only.
    const rows = buildPriyaConversation();
    const patched = rows.map((row, index) =>
      index === 2 ? { ...row, direction: "outgoing" as const, sender_label: "Priya" } : row,
    );

    const input = toAnalysisInput(patched, OPTIONS);
    const resolution = resolveParticipants(input);

    // Now "Priya" appears on both sides -> untrusted, not silently merged.
    expect(resolution.isUsable).toBe(false);
  });

  it("excludes messages with no timestamp from analysis", () => {
    const rows = buildPriyaConversation();
    const withNull = rows.map((row, index) => (index === 0 ? { ...row, sent_at: null } : row));
    const input = toAnalysisInput(withNull, OPTIONS);

    expect(input.messages).toHaveLength(rows.length - 1);
  });
});
