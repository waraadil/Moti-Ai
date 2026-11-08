import { describe, expect, it } from "vitest";
import {
  extractDetails,
  extractOpenThreads,
  extractPlans,
  extractQuestions,
  extractTopics,
  understandConversation,
} from "@/lib/intelligence/understanding";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { buildContradictionConversation, buildPriyaConversation } from "../fixtures/conversations";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

function priyaMessages() {
  return toAnalysisInput(buildPriyaConversation(), OPTIONS).messages;
}

describe("topic extraction", () => {
  it("finds recurring topics with citations", () => {
    const topics = extractTopics(priyaMessages());
    const labels = topics.map((topic) => topic.label);

    expect(labels).toContain("health"); // marathon training
    expect(labels).toContain("social"); // Saturday plans
    expect(labels).toContain("family"); // sister

    const health = topics.find((topic) => topic.label === "health");
    expect(health?.mentions).toBeGreaterThan(1);
    expect(health?.messageIds.length).toBeGreaterThan(0);
    expect(health?.status).toBe("inferred");
    // Every cited id must exist in the conversation.
    const allIds = new Set(priyaMessages().map((message) => message.id));
    for (const id of health?.messageIds ?? []) expect(allIds.has(id)).toBe(true);
  });

  it("orders topics by number of mentions", () => {
    const topics = extractTopics(priyaMessages());
    for (let index = 1; index < topics.length; index += 1) {
      expect((topics[index - 1] as { mentions: number }).mentions).toBeGreaterThanOrEqual(
        (topics[index] as { mentions: number }).mentions,
      );
    }
  });

  it("returns nothing for a conversation with no known vocabulary", () => {
    const topics = extractTopics([
      {
        id: "1",
        participant: "contact",
        senderLabel: "Sam",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "xyzzy plugh frobnicate",
        kind: "text",
      },
    ]);
    expect(topics).toEqual([]);
  });
});

describe("plan extraction", () => {
  it("marks a plan agreed when someone confirms it", () => {
    const plans = extractPlans(priyaMessages());
    const saturday = plans.find((plan) => /saturday/i.test(plan.description));

    expect(saturday).toBeDefined();
    expect(["agreed", "proposed"]).toContain(saturday?.status);
    expect(saturday?.citations.length).toBeGreaterThan(0);
  });

  it("marks a plan completed when a follow-up confirms it", () => {
    const plans = extractPlans(priyaMessages());
    const booking = plans.find((plan) => /book/i.test(plan.description));

    expect(booking).toBeDefined();
    // "i'll book a table" is followed by "booked it, 7pm saturday".
    expect(["completed", "agreed"]).toContain(booking?.status);
  });

  it("detects a cancelled plan in the contradiction fixture", () => {
    const plans = extractPlans(toAnalysisInput(buildContradictionConversation(), OPTIONS).messages);
    const cancelled = plans.find((plan) => plan.status === "cancelled");

    expect(cancelled).toBeDefined();
    expect(cancelled?.citations.length).toBeGreaterThan(0);
  });

  it("never reports a plan as completed without follow-up evidence", () => {
    const plans = extractPlans([
      {
        id: "1",
        participant: "contact",
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "I'm planning to book the van next week",
        kind: "text",
      },
    ]);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.status).toBe("proposed");
  });

  it("keeps every citation anchored to a real message with its timestamp", () => {
    const messages = priyaMessages();
    const byId = new Map(messages.map((message) => [message.id, message]));

    for (const plan of extractPlans(messages)) {
      for (const citation of plan.citations) {
        const source = byId.get(citation.messageId);
        expect(source).toBeDefined();
        expect(citation.saidAt).toBe(source?.sentAt);
        expect(citation.speakerLabel).toBe(source?.senderLabel);
        expect(citation.excerpt.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("question extraction", () => {
  it("records who asked and whether a reply followed", () => {
    const questions = extractQuestions(priyaMessages());
    expect(questions.length).toBeGreaterThan(2);

    const interviewQuestion = questions.find((question) => /interview/i.test(question.text));
    expect(interviewQuestion?.askedBy).toBe("contact");
    expect(interviewQuestion?.appearsUnanswered).toBe(false);
  });

  it("flags a question with no reply as unanswered, not as ignored", () => {
    const questions = extractQuestions([
      {
        id: "1",
        participant: "contact",
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "Are you free on Friday?",
        kind: "text",
      },
      {
        id: "2",
        participant: "contact",
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:01:00.000Z",
        body: "No worries if not",
        kind: "text",
      },
    ]);

    expect(questions[0]?.appearsUnanswered).toBe(true);
  });
});

describe("open threads", () => {
  it("surfaces an unresolved plan as an open thread", () => {
    const messages = priyaMessages();
    const topics = extractTopics(messages);
    const plans = extractPlans(messages);
    const questions = extractQuestions(messages);
    const threads = extractOpenThreads(messages, topics, plans, questions);

    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) {
      expect(thread.reason.length).toBeGreaterThan(10);
      expect(thread.citations.length).toBeGreaterThan(0);
      expect(thread.status_).toBe("inferred");
    }
  });
});

describe("detail extraction", () => {
  it("captures dates and times with their source message", () => {
    const details = extractDetails(priyaMessages());
    const values = details.map((detail) => detail.value);

    expect(values.some((value) => /saturday/i.test(value))).toBe(true);
    expect(values.some((value) => /7pm|19:00|7 pm/i.test(value))).toBe(true);

    for (const detail of details) {
      expect(detail.citation.messageId).toBeTruthy();
      expect(detail.citation.saidAt).toBeTruthy();
    }
  });
});

describe("conversation understanding", () => {
  it("produces a complete, self-consistent result", () => {
    const messages = priyaMessages();
    const understanding = understandConversation(messages);

    expect(understanding.messageCount).toBeGreaterThan(0);
    expect(understanding.topics.length).toBeGreaterThan(0);
    expect(Array.isArray(understanding.plans)).toBe(true);
    expect(Array.isArray(understanding.openThreads)).toBe(true);

    // Direct evidence vs interpretation are distinguishable.
    for (const plan of understanding.plans) expect(plan.status_).toBe("direct");
    for (const topic of understanding.topics) expect(topic.status).toBe("inferred");
  });

  it("excludes system messages and media placeholders", () => {
    const understanding = understandConversation([
      {
        id: "1",
        participant: "system",
        senderLabel: null,
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "Messages and calls are end-to-end encrypted.",
        kind: "system",
      },
      {
        id: "2",
        participant: "contact",
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:01:00.000Z",
        body: "",
        kind: "media",
      },
    ]);

    expect(understanding.messageCount).toBe(0);
    expect(understanding.topics).toEqual([]);
  });
});
