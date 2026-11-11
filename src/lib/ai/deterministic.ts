/**
 * Deterministic analysis provider.
 *
 * Not a stub: it performs real extraction over the transcript using the rule
 * engines in `src/lib/intelligence`, and returns JSON that satisfies the same
 * schemas the model output must satisfy. It runs with no network access, no API
 * key and no cost, and produces identical results for identical input — which is
 * what makes the pipeline testable.
 *
 * It is weaker than a language model: it recognises phrasings, it does not
 * understand them. Every result it produces is labelled with
 * `provider: "deterministic"` so nothing implies otherwise.
 */

import "server-only";

import { describeStyle, type StyleMetrics } from "@/lib/intelligence/style";
import { extractMemoriesByRule } from "@/lib/intelligence/memory-rules";
import { analyseStyle } from "@/lib/intelligence/style";
import {
  understandConversation,
  type ConversationUnderstanding,
} from "@/lib/intelligence/understanding";
import type { AnalysisMessage, ConversationInput } from "@/lib/intelligence/types";
import type { AnalysisProvider, LlmRequest, LlmResponse, ModelIdentity } from "./types";

export type DeterministicTask =
  | { kind: "memories"; input: ConversationInput }
  | { kind: "style"; input: ConversationInput }
  | { kind: "summary"; input: ConversationInput }
  | { kind: "reply"; input: ConversationInput; payload: unknown };

/**
 * The provider needs the structured conversation, which is not carried in the
 * prompt text. The pipeline attaches it per request via `withTask`.
 */
export class DeterministicProvider implements AnalysisProvider {
  readonly identity: ModelIdentity = {
    provider: "deterministic",
    model: "moti-rules-v1",
  };
  readonly isGenerative = false;

  private pending: DeterministicTask | null = null;

  /** Binds the structured input for the next `complete()` call. */
  withTask(task: DeterministicTask): this {
    this.pending = task;
    return this;
  }

  async complete(_request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    const task = this.pending;
    this.pending = null;

    if (!task) {
      throw new Error(
        "DeterministicProvider requires withTask() so it has the structured conversation.",
      );
    }

    const text = JSON.stringify(runTask(task));

    return {
      text,
      identity: this.identity,
      usage: null,
      durationMs: Date.now() - startedAt,
      // No HTTP involved: the rule engine runs in-process.
      attempts: 1,
    };
  }
}

/** Pure task runner: exported so tests can assert on output without HTTP. */
export function runTask(task: DeterministicTask): unknown {
  switch (task.kind) {
    case "memories": {
      const { candidates, rejected } = extractMemoriesByRule(task.input.messages, {
        selfName: task.input.selfName,
        contactName: task.input.contactName,
      });

      return {
        memories: candidates,
        uncertainObservations: rejected.slice(0, 10).map((entry) => ({
          observation: entry.excerpt,
          reason: entry.reason,
          evidenceMessageIds: [] as string[],
        })),
      };
    }

    case "style": {
      const self = analyseStyle(task.input.messages, "self");
      const contact = analyseStyle(task.input.messages, "contact");

      return {
        selfSummary: describeStyle(self, task.input.selfName ?? "You"),
        contactSummary: describeStyle(contact, task.input.contactName),
        contrasts: buildContrasts(self, contact),
      };
    }

    case "summary": {
      const understanding = understandConversation(task.input.messages);
      return {
        summary: buildSummary(understanding, task.input.contactName),
        recurringTopics: understanding.topics.slice(0, 8).map((topic) => topic.label),
        importantDetails: understanding.details.slice(0, 10).map((detail) => ({
          detail: `${detail.kind}: ${detail.value}`,
          evidenceMessageIds: [detail.citation.messageId],
        })),
      };
    }

    case "reply": {
      const payload = task.payload as ReplyPayload;
      return buildReplyDrafts(payload);
    }
  }
}

function buildContrasts(
  self: StyleMetrics,
  contact: StyleMetrics,
): Array<{ metric: string; observation: string }> {
  const contrasts: Array<{ metric: string; observation: string }> = [];

  const compare = (metric: string, a: number, b: number, unit: string, label: string) => {
    if (a === b) return;
    const longer = a > b ? "self" : "contact";
    const difference = Math.abs(a - b);
    if (difference < Math.max(0.1, Math.min(a, b) * 0.15)) return;
    contrasts.push({
      metric,
      observation: `${longer === "self" ? "You" : "They"} ${label} ${unit} more (${a} vs ${b}).`,
    });
  };

  compare("medianChars", self.medianChars, contact.medianChars, "characters", "write");
  compare(
    "emojiRatio",
    Math.round(self.emojiRatio * 100),
    Math.round(contact.emojiRatio * 100),
    "percentage points",
    "use emoji",
  );
  compare(
    "questionRatio",
    Math.round(self.questionRatio * 100),
    Math.round(contact.questionRatio * 100),
    "percentage points",
    "ask questions",
  );

  return contrasts.slice(0, 5);
}

function buildSummary(understanding: ConversationUnderstanding, contactName: string): string {
  const parts: string[] = [];

  if (understanding.topics.length > 0) {
    parts.push(
      `Recurring topics: ${understanding.topics
        .slice(0, 5)
        .map((topic) => topic.label)
        .join(", ")}.`,
    );
  } else {
    parts.push("No recurring topic categories were detected in this window.");
  }

  const openPlans = understanding.plans.filter(
    (plan) => plan.status === "proposed" || plan.status === "agreed",
  );
  if (openPlans.length > 0) {
    parts.push(
      `${openPlans.length} plan${openPlans.length === 1 ? "" : "s"} were raised without a confirmation that they happened.`,
    );
  }

  const unanswered = understanding.questions.filter((question) => question.appearsUnanswered);
  if (unanswered.length > 0) {
    parts.push(
      `${unanswered.length} question${unanswered.length === 1 ? "" : "s"} appear to have no reply in this window.`,
    );
  }

  parts.push(`Based on ${understanding.messageCount} text messages with ${contactName}.`);

  return parts.join(" ");
}

type ReplyPayload = {
  contactName: string;
  selfName: string | null;
  latestIncoming: string | null;
  style: StyleMetrics;
  memories: Array<{ id: string; statement: string }>;
  openThreads: string[];
};

/**
 * Deterministic draft suggestions.
 *
 * These are assembled from the user's own observed habits (length, emoji use,
 * punctuation) plus the open thread, and contain no invented commitments. They
 * are intentionally plain: the value is that they are grounded and safe, not
 * that they are eloquent.
 */
export function buildReplyDrafts(payload: ReplyPayload): {
  drafts: Array<{ body: string; tone: string; rationale: string; usedMemoryIds: string[] }>;
} {
  const { style, latestIncoming, openThreads, memories, contactName } = payload;
  const drafts: Array<{ body: string; tone: string; rationale: string; usedMemoryIds: string[] }> =
    [];

  const useEmoji = style.emojiRatio >= 0.25;
  const short = style.medianChars <= 40;
  const thread = openThreads[0] ?? null;
  const memory = memories[0] ?? null;

  // Draft 1: acknowledges the message and, when there is one, the open thread.
  if (thread) {
    drafts.push({
      body: short
        ? `Still up for sorting the ${thread} thing?${useEmoji ? " 🙂" : ""}`
        : `Coming back to the ${thread} question — where did we land on it?${useEmoji ? " 🙂" : ""}`,
      tone: "checking in",
      rationale: `Follows up the open thread about ${thread} without committing you to anything.`,
      usedMemoryIds: memory ? [memory.id] : [],
    });
  }

  if (latestIncoming) {
    const acknowledges = latestIncoming.trim().endsWith("?");
    drafts.push({
      body: acknowledges
        ? `Good question — let me think and come back to you${useEmoji ? " 🙂" : ""}`
        : `Got it, thanks for letting me know${useEmoji ? " 🙂" : ""}`,
      tone: "neutral acknowledgement",
      rationale:
        "Acknowledges the latest message and defers, so no promise or opinion is put in your mouth.",
      usedMemoryIds: [],
    });
  }

  if (memory && drafts.length < 3) {
    drafts.push({
      body: short
        ? `How's the ${memory.statement.replace(/^[^ ]+ /, "").slice(0, 40)} going?`
        : `You mentioned ${memory.statement.replace(/^[^ ]+ /, "")} — how is that going with ${contactName}?`,
      tone: "warm follow-up",
      rationale: `References a stored memory: "${memory.statement}".`,
      usedMemoryIds: [memory.id],
    });
  }

  return { drafts: drafts.slice(0, 3) };
}

/** Re-exported for tests that build inputs directly. */
export type { AnalysisMessage };
