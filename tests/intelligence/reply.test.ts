import { describe, expect, it } from "vitest";
import {
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  selectUsableMemories,
  validateReplyOutput,
  type ReplyContext,
  type ReplyMemory,
} from "@/lib/intelligence/reply";
import { findForbiddenDraftPhrase, replyDraftOutputSchema } from "@/lib/intelligence/schemas";
import { analyseConversationStyle } from "@/lib/intelligence/style";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { runTask } from "@/lib/ai/deterministic";
import { buildPriyaConversation } from "../fixtures/conversations";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

function buildContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  const input = toAnalysisInput(buildPriyaConversation(), OPTIONS);
  const style = analyseConversationStyle(input.messages);
  const incoming = input.messages.filter((message) => message.participant === "contact");

  return {
    contactName: "Priya",
    selfName: "Wara",
    latestIncoming: incoming[incoming.length - 1] ?? null,
    recentMessages: input.messages.slice(-12),
    selfStyle: style.self,
    contactStyle: style.contact,
    openThreads: ["social"],
    memories: [
      {
        id: "mem-1",
        statement: "Priya is training for the Lisbon marathon",
        confidence: 0.8,
        isUserConfirmed: false,
      },
    ],
    tone: null,
    ...overrides,
  };
}

describe("memory selection for replies", () => {
  it("only offers confirmed or well-supported memories", () => {
    const memories: ReplyMemory[] = [
      { id: "a", statement: "Confirmed fact", confidence: 0.2, isUserConfirmed: true },
      { id: "b", statement: "Well supported", confidence: 0.75, isUserConfirmed: false },
      { id: "c", statement: "Weak guess", confidence: 0.2, isUserConfirmed: false },
    ];

    const selected = selectUsableMemories(memories);
    const ids = selected.map((memory) => memory.id);

    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c");
  });

  it("puts user-confirmed memories first", () => {
    const selected = selectUsableMemories([
      { id: "weak", statement: "x", confidence: 0.65, isUserConfirmed: false },
      { id: "confirmed", statement: "y", confidence: 0.6, isUserConfirmed: true },
    ]);

    expect(selected[0]?.id).toBe("confirmed");
  });
});

describe("reply prompt", () => {
  it("states the no-invention rules explicitly", () => {
    const prompt = buildReplySystemPrompt();

    expect(prompt).toMatch(/never invent promises/i);
    expect(prompt).toMatch(/feelings, opinions/i);
    expect(prompt).toMatch(/only reference facts listed under known memories/i);
  });

  it("includes the user's measured style and the supplied memories", () => {
    const context = buildContext();
    const prompt = buildReplyUserPrompt(context);

    expect(prompt).toContain("USER STYLE:");
    expect(prompt).toMatch(/median \d+ chars/);
    expect(prompt).toContain("mem-1");
    expect(prompt).toContain("Lisbon marathon");
    expect(prompt).toContain("CONTACT NAME: Priya");
  });

  it("does not leak anything beyond the provided context", () => {
    const prompt = buildReplyUserPrompt(buildContext({ memories: [] }));
    expect(prompt).toContain("KNOWN MEMORIES (the only facts you may reference):\n- none");
  });
});

describe("draft validation", () => {
  it("rejects promises made on the user's behalf", () => {
    const plan = validateReplyOutput(
      {
        drafts: [
          {
            body: "I promise I'll be there at seven.",
            tone: "warm",
            rationale: "test draft",
            usedMemoryIds: [],
          },
        ],
      },
      buildContext(),
    );

    expect(plan.drafts).toHaveLength(0);
    expect(plan.isEmpty).toBe(true);
    expect(plan.rejected[0]?.reason).toMatch(/promise/i);
  });

  it("rejects invented feelings", () => {
    for (const body of ["I love you too", "I'm sorry for everything", "I miss you"]) {
      const plan = validateReplyOutput(
        { drafts: [{ body, tone: "warm", rationale: "test draft", usedMemoryIds: [] }] },
        buildContext(),
      );
      expect(plan.drafts, body).toHaveLength(0);
    }
  });

  it("rejects commitments to actions", () => {
    const plan = validateReplyOutput(
      {
        drafts: [
          {
            body: "I will book the van for Saturday.",
            tone: "practical",
            rationale: "test draft",
            usedMemoryIds: [],
          },
        ],
      },
      buildContext(),
    );

    expect(plan.isEmpty).toBe(true);
    expect(plan.rejected[0]?.reason).toMatch(/commits the user/i);
  });

  it("rejects drafts citing memories that were not provided", () => {
    const plan = validateReplyOutput(
      {
        drafts: [
          {
            body: "Hope the move goes well!",
            tone: "warm",
            rationale: "references the move",
            usedMemoryIds: ["mem-does-not-exist"],
          },
        ],
      },
      buildContext(),
    );

    expect(plan.isEmpty).toBe(true);
    expect(plan.rejected[0]?.reason).toMatch(/not provided/i);
  });

  it("accepts a grounded, commitment-free draft", () => {
    const context = buildContext();
    const plan = validateReplyOutput(
      {
        drafts: [
          {
            body: "How's the marathon training going?",
            tone: "warm",
            rationale: "asks about a known interest",
            usedMemoryIds: ["mem-1"],
          },
        ],
      },
      context,
    );

    expect(plan.isEmpty).toBe(false);
    expect(plan.drafts[0]?.body).toBe("How's the marathon training going?");
    expect(plan.drafts[0]?.usedMemoryIds).toEqual(["mem-1"]);
  });

  it("returns an empty plan for malformed model output instead of throwing", () => {
    for (const raw of [{}, { drafts: "nope" }, null, []]) {
      const plan = validateReplyOutput(raw, buildContext());
      expect(plan.isEmpty).toBe(true);
      expect(plan.drafts).toEqual([]);
    }
  });

  it("drops only the bad drafts, keeping the good ones", () => {
    const plan = validateReplyOutput(
      {
        drafts: [
          {
            body: "I promise I'll call tonight.",
            tone: "test tone",
            rationale: "test draft",
            usedMemoryIds: [],
          },
          {
            body: "Sounds good 🙂",
            tone: "casual",
            rationale: "matches your style",
            usedMemoryIds: [],
          },
        ],
      },
      buildContext(),
    );

    expect(plan.drafts).toHaveLength(1);
    expect(plan.drafts[0]?.body).toBe("Sounds good 🙂");
    expect(plan.rejected).toHaveLength(1);
  });
});

describe("deterministic reply generation", () => {
  it("produces schema-valid drafts without inventing commitments", () => {
    const context = buildContext();
    const output = runTask({
      kind: "reply",
      input: toAnalysisInput(buildPriyaConversation(), OPTIONS),
      payload: {
        contactName: context.contactName,
        selfName: context.selfName,
        latestIncoming: context.latestIncoming?.body ?? null,
        style: context.selfStyle,
        memories: context.memories.map((memory) => ({
          id: memory.id,
          statement: memory.statement,
        })),
        openThreads: context.openThreads,
      },
    });

    expect(replyDraftOutputSchema.safeParse(output).success).toBe(true);

    const plan = validateReplyOutput(output, context);
    expect(plan.isEmpty).toBe(false);

    for (const draft of plan.drafts) {
      expect(findForbiddenDraftPhrase(draft.body)).toBeNull();
    }
  });
});
