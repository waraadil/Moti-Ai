import { describe, expect, it } from "vitest";
import {
  analyseConversationStyle,
  analyseStyle,
  computeReplyDelays,
  describeStyle,
} from "@/lib/intelligence/style";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { SAMPLE_THRESHOLDS } from "@/lib/intelligence/types";
import {
  buildOneSidedConversation,
  buildPriyaConversation,
  buildTinyConversation,
} from "../fixtures/conversations";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

function priyaInput() {
  return toAnalysisInput(buildPriyaConversation(), OPTIONS);
}

describe("style analysis", () => {
  it("analyses each participant independently", () => {
    const { self, contact } = analyseConversationStyle(priyaInput().messages);

    expect(self.participant).toBe("self");
    expect(contact.participant).toBe("contact");

    // Priya writes measurably longer messages in this fixture.
    expect(contact.medianChars).toBeGreaterThan(self.medianChars);
    // Both sides were actually analysed.
    expect(self.messageCount).toBeGreaterThan(5);
    expect(contact.messageCount).toBeGreaterThan(5);
  });

  it("never mixes the other participant's messages into a profile", () => {
    const input = priyaInput();
    const onlySelf = input.messages.map((message) => ({
      ...message,
      participant: "self" as const,
      senderLabel: "Wara",
    }));

    const contactsProfile = analyseStyle(onlySelf, "contact");
    expect(contactsProfile.messageCount).toBe(0);
    expect(contactsProfile.isInsufficient).toBe(true);
  });

  it("measures emoji, lowercase, questions and punctuation", () => {
    const messages = [
      {
        id: "1",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:00:00.000Z",
        body: "ok 🙂",
        kind: "text" as const,
      },
      {
        id: "2",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:01:00.000Z",
        body: "sounds good",
        kind: "text" as const,
      },
      {
        id: "3",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:02:00.000Z",
        body: "Are you coming?!",
        kind: "text" as const,
      },
      {
        id: "4",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:03:00.000Z",
        body: "yes 😂😂",
        kind: "text" as const,
      },
    ];

    const metrics = analyseStyle(messages, "self");

    expect(metrics.emojiRatio).toBeCloseTo(0.5, 2);
    expect(metrics.questionRatio).toBeCloseTo(0.25, 2);
    expect(metrics.exclamationRate).toBeGreaterThan(0);
    // "ok 🙂", "sounds good" and "yes 😂😂" are all lower case; only line 3 is not.
    expect(metrics.lowercaseRatio).toBeCloseTo(0.75, 2);
    expect(metrics.topEmoji[0]?.emoji).toBe("😂");
  });

  it("computes reply latency from alternating turns only", () => {
    const messages = [
      {
        id: "1",
        participant: "contact" as const,
        senderLabel: "B",
        sentAt: "2024-01-01T10:00:00.000Z",
        body: "hi",
        kind: "text" as const,
      },
      {
        id: "2",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:05:00.000Z",
        body: "hello",
        kind: "text" as const,
      },
      {
        id: "3",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-01-01T10:06:00.000Z",
        body: "again",
        kind: "text" as const,
      },
      {
        id: "4",
        participant: "contact" as const,
        senderLabel: "B",
        sentAt: "2024-01-01T10:20:00.000Z",
        body: "hey",
        kind: "text" as const,
      },
    ];

    // Self replied 5 min after contact; the 10:06 message is not a reply.
    expect(computeReplyDelays(messages, "self")).toEqual([5]);
    // Contact replied 14 min after the last self message.
    expect(computeReplyDelays(messages, "contact")).toEqual([14]);
  });

  it("ignores gaps longer than a week so old threads do not skew the median", () => {
    const messages = [
      {
        id: "1",
        participant: "contact" as const,
        senderLabel: "B",
        sentAt: "2024-01-01T10:00:00.000Z",
        body: "hi",
        kind: "text" as const,
      },
      {
        id: "2",
        participant: "self" as const,
        senderLabel: "A",
        sentAt: "2024-03-01T10:00:00.000Z",
        body: "hello",
        kind: "text" as const,
      },
    ];

    expect(computeReplyDelays(messages, "self")).toEqual([]);
  });

  it("flags an insufficient sample instead of inventing a profile", () => {
    const input = toAnalysisInput(buildTinyConversation(), {
      contactName: "Sam",
      selfName: "Wara",
    });
    const style = analyseConversationStyle(input.messages);

    expect(style.self.coverage.level).toBe("insufficient");
    expect(style.contact.coverage.level).toBe("insufficient");
    expect(style.isReliable).toBe(false);
    expect(style.self.coverage.note).toMatch(/need at least/i);
  });

  it("lowers confidence for a small but usable sample", () => {
    const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
    const style = analyseConversationStyle(input.messages);

    // The fixture has ~20 messages per side: enough to profile, not enough to be sure.
    expect(style.self.messageCount).toBeGreaterThanOrEqual(SAMPLE_THRESHOLDS.insufficient);
    expect(["low", "moderate", "strong"]).toContain(style.self.coverage.level);
    expect(style.self.confidence).toBeGreaterThan(0);
    expect(style.self.confidence).toBeLessThanOrEqual(1);
  });

  it("produces an honest description that mentions the sample size", () => {
    const input = toAnalysisInput(buildTinyConversation(), {
      contactName: "Sam",
      selfName: "Wara",
    });
    const style = analyseStyle(input.messages, "contact");
    const description = describeStyle(style, "Sam");

    expect(description).toMatch(/only \d+ usable message/i);
    expect(description).toMatch(/indicative only/i);
  });

  it("handles a participant with no messages without throwing", () => {
    const input = toAnalysisInput(buildOneSidedConversation(), {
      contactName: "Sam",
      selfName: "Wara",
    });
    const style = analyseStyle(input.messages, "contact");

    expect(style.messageCount).toBe(0);
    expect(style.medianReplyMinutes).toBeNull();
    expect(style.topWords).toEqual([]);
    expect(style.isInsufficient).toBe(true);
  });
});
