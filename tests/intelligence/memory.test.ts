import { describe, expect, it } from "vitest";
import { extractMemoriesByRule } from "@/lib/intelligence/memory-rules";
import { memoryExtractionOutputSchema } from "@/lib/intelligence/schemas";
import { memoryFingerprint } from "@/server/analysis/pipeline";
import { runTask } from "@/lib/ai/deterministic";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { buildContradictionConversation, buildPriyaConversation } from "../fixtures/conversations";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

function priyaInput() {
  return toAnalysisInput(buildPriyaConversation(), OPTIONS);
}

describe("memory extraction", () => {
  it("extracts self-describing facts from the contact with citations", () => {
    const input = priyaInput();
    const { candidates } = extractMemoriesByRule(input.messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    expect(candidates.length).toBeGreaterThan(0);

    const marathon = candidates.find((candidate) => /marathon/i.test(candidate.statement));
    expect(marathon).toBeDefined();
    expect(marathon?.evidenceMessageIds.length).toBeGreaterThan(0);
    expect(marathon?.confidence).toBeGreaterThan(0);

    // Every cited id must be a real message id.
    const ids = new Set(input.messages.map((message) => message.id));
    for (const candidate of candidates) {
      for (const id of candidate.evidenceMessageIds) expect(ids.has(id)).toBe(true);
    }
  });

  it("always produces at least one citation per memory", () => {
    const { candidates } = extractMemoriesByRule(priyaInput().messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    for (const candidate of candidates) {
      expect(candidate.evidenceMessageIds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("rejects speculation instead of storing it as fact", () => {
    const input = toAnalysisInput(buildContradictionConversation(), OPTIONS);
    const { candidates, rejected } = extractMemoriesByRule(input.messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    // "Maybe I'll move to Berlin after that, not sure yet" must not become a memory.
    const berlin = candidates.find((candidate) => /berlin/i.test(candidate.statement));
    expect(berlin).toBeUndefined();
    expect(
      rejected.some((entry) => /berlin/i.test(entry.excerpt) || /uncertain/i.test(entry.reason)),
    ).toBe(true);
  });

  it("does not treat a question as a statement of fact", () => {
    const messages = [
      {
        id: "q1",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "Do I look like I enjoy running in the rain?",
        kind: "text" as const,
      },
    ];

    const { candidates } = extractMemoriesByRule(messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    expect(candidates).toEqual([]);
  });

  it("attributes a fact to the right speaker", () => {
    const messages = [
      {
        id: "m1",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "I'm training for the Lisbon marathon",
        kind: "text" as const,
      },
      {
        id: "m2",
        participant: "self" as const,
        senderLabel: "Wara",
        sentAt: "2024-01-01T00:05:00.000Z",
        body: "I'm training for the Berlin half",
        kind: "text" as const,
      },
    ];

    const { candidates } = extractMemoriesByRule(messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    const contactFact = candidates.find((candidate) => /Lisbon/.test(candidate.statement));
    const selfFact = candidates.find((candidate) => /Berlin/.test(candidate.statement));

    expect(contactFact?.statement).toMatch(/^Priya /);
    expect(contactFact?.about).toBe("contact");
    expect(selfFact?.statement).toMatch(/^Wara /);
    expect(selfFact?.about).toBe("self");
  });

  it("collapses the same fact stated twice instead of duplicating it", () => {
    const stats = [
      {
        id: "m1",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "I love running",
        kind: "text" as const,
      },
      {
        id: "m2",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-02T00:00:00.000Z",
        body: "I really love running",
        kind: "text" as const,
      },
    ];

    const { candidates } = extractMemoriesByRule(stats, {
      selfName: "Wara",
      contactName: "Priya",
    });

    // One memory, with both messages as evidence.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.evidenceMessageIds).toHaveLength(2);
  });

  it("produces readable third-person statements, not sentence fragments", () => {
    const { candidates } = extractMemoriesByRule(priyaInput().messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      // Starts with the person's name, so attribution is always visible.
      expect(candidate.statement).toMatch(/^(?:Priya|Wara) /);
      // No dangling conjunctions or mid-sentence joins.
      expect(candidate.statement).not.toMatch(/\bso I'm\b|\bby the way\b|\btbh$/i);
      // No doubled phrasing artefacts.
      expect(candidate.statement).not.toMatch(/\b(\w+) \1\b/);
      expect(candidate.statement.length).toBeGreaterThan(15);
    }
  });

  it("does not turn advice given to the other person into a boundary", () => {
    const messages = [
      {
        id: "b1",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "You should! Start with 5k and don't do too much at once.",
        kind: "text" as const,
      },
    ];

    const { candidates } = extractMemoriesByRule(messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    expect(candidates).toEqual([]);
  });

  it("produces output that satisfies the model schema", () => {
    const output = runTask({ kind: "memories", input: priyaInput() });
    const validated = memoryExtractionOutputSchema.safeParse(output);

    expect(validated.success).toBe(true);
  });

  it("marks sensitive disclosures as sensitive", () => {
    const messages = [
      {
        id: "s1",
        participant: "contact" as const,
        senderLabel: "Priya",
        sentAt: "2024-01-01T00:00:00.000Z",
        body: "I'm struggling with anxiety at the moment",
        kind: "text" as const,
      },
    ];

    const { candidates } = extractMemoriesByRule(messages, {
      selfName: "Wara",
      contactName: "Priya",
    });

    expect(candidates[0]?.isSensitive).toBe(true);
    expect(candidates[0]?.category).toBe("sensitive");
  });
});

describe("memory fingerprints", () => {
  it("are stable for the same statement", () => {
    expect(memoryFingerprint("Priya is training for a marathon")).toBe(
      memoryFingerprint("Priya is training for a marathon"),
    );
  });

  it("ignore punctuation, case and whitespace differences", () => {
    expect(memoryFingerprint("Priya likes coffee.")).toBe(
      memoryFingerprint("  priya   likes COFFEE!  "),
    );
  });

  it("differ for genuinely different facts", () => {
    expect(memoryFingerprint("Priya likes coffee")).not.toBe(
      memoryFingerprint("Priya dislikes coffee"),
    );
  });
});
