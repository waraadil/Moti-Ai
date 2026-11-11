/**
 * Reply intelligence.
 *
 * Drafts are constrained on three sides:
 *
 *   1. Input: the prompt contains only the user's observed style, the contact's
 *      style, recent messages, open threads and *confirmed-or-high-confidence*
 *      memories. Nothing about the user's feelings is stated anywhere.
 *   2. Output: every draft is validated against a schema and then screened for
 *      commitments, promises and asserted emotions.
 *   3. Storage: drafts are saved with status `draft`. There is no send path in
 *      this codebase, and none is planned — sending is the user's job.
 */

import { findForbiddenDraftPhrase, replyDraftOutputSchema, type ReplyDraftOutput } from "./schemas";
import type { StyleMetrics } from "./style";
import type { AnalysisMessage } from "./types";

export type ReplyMemory = {
  id: string;
  statement: string;
  confidence: number;
  isUserConfirmed: boolean;
};

export type ReplyContext = {
  contactName: string;
  selfName: string | null;
  /** The most recent incoming message, the one being replied to. */
  latestIncoming: AnalysisMessage | null;
  recentMessages: AnalysisMessage[];
  selfStyle: StyleMetrics;
  contactStyle: StyleMetrics;
  openThreads: string[];
  memories: ReplyMemory[];
  tone: string | null;
  /** Evidence of what the user accepted before; empty on a first run. */
  feedback?: ReplyFeedback;
};

export type AcceptedDraft = {
  body: string;
  tone: string;
  rationale: string;
  usedMemoryIds: string[];
};

export type RejectedDraft = {
  body: string;
  reason: string;
};

/**
 * What the user did with earlier suggestions for the same contact.
 *
 * Rejected and edited drafts are the most useful signal: an edit shows exactly
 * which words the user did not want to send.
 */
export type ReplyFeedback = {
  /** Sent unchanged. Shape and tone to lean towards. */
  accepted: Array<{ body: string; tone: string | null }>;
  /** Changed before sending. `original` is what to avoid, `edited` what to prefer. */
  edited: Array<{ original: string; edited: string }>;
  /** Thrown away without sending. Never repeat these. */
  rejected: Array<{ body: string }>;
};

export type ReplyPlan = {
  drafts: AcceptedDraft[];
  rejected: RejectedDraft[];
  /** True when the model produced nothing usable. */
  isEmpty: boolean;
};

/**
 * Only memories the user confirmed or that carry real support are offered to the
 * generator. Weak memories would turn speculation into a "fact" in a message
 * the user might actually send.
 */
export function selectUsableMemories(memories: readonly ReplyMemory[]): ReplyMemory[] {
  return memories
    .filter((memory) => memory.isUserConfirmed || memory.confidence >= 0.6)
    .sort(
      (a, b) =>
        Number(b.isUserConfirmed) - Number(a.isUserConfirmed) || b.confidence - a.confidence,
    )
    .slice(0, 12);
}

/**
 * Builds the system prompt.
 *
 * Written as explicit constraints rather than a persona so the rules survive
 * model changes, and so they can be asserted in tests.
 */
export function buildReplySystemPrompt(): string {
  return [
    "You draft text messages on behalf of a user, to be reviewed before sending.",
    "Absolute rules:",
    "- Never invent promises, commitments, feelings, opinions, or personal experiences for the user.",
    "- Never state that the user will do something. Offer wording, not obligations.",
    "- Only reference facts listed under KNOWN MEMORIES. Do not add new personal details.",
    "- Match the user's observed writing style exactly: message length, punctuation, emoji use, formality.",
    "- If the conversation needs information you do not have, draft a question instead of an answer.",
    "- Never mention that you are an AI or that this is a suggestion.",
    "Return JSON only, matching: { drafts: [{ body, tone, rationale, usedMemoryIds }] }.",
  ].join("\n");
}

/** Serialises the context into the user turn. */
/**
 * Turns past accept/edit/reject behaviour into prompt guidance.
 *
 * Omitting the block entirely on a first run matters: an empty "LEARNED
 * PREFERENCES" heading would imply Moti has learned something when it has not.
 */
function feedbackLines(feedback: ReplyFeedback | undefined): string[] {
  if (!feedback) return [];

  const lines: string[] = [];

  if (feedback.edited.length > 0) {
    lines.push("HOW THE USER REWROTE PREVIOUS DRAFTS (learn from the difference):");
    for (const edit of feedback.edited) {
      lines.push(`- SUGGESTED: ${edit.original}`);
      lines.push(`  SENT AS: ${edit.edited}`);
    }
    lines.push("");
  }

  if (feedback.accepted.length > 0) {
    lines.push("DRAFTS THE USER SENT UNCHANGED (match this shape):");
    for (const accepted of feedback.accepted) {
      lines.push(`- ${accepted.body}${accepted.tone ? ` (tone: ${accepted.tone})` : ""}`);
    }
    lines.push("");
  }

  if (feedback.rejected.length > 0) {
    lines.push("DRAFTS THE USER DISCARDED (do not repeat anything like these):");
    for (const rejected of feedback.rejected) {
      lines.push(`- ${rejected.body}`);
    }
    lines.push("");
  }

  return lines;
}

export function buildReplyUserPrompt(context: ReplyContext): string {
  const format = (message: AnalysisMessage) =>
    `[${message.sentAt}] ${message.participant === "self" ? "USER" : "CONTACT"}: ${message.body}`;

  const styleLine = (label: string, style: StyleMetrics) =>
    `${label}: median ${style.medianChars} chars, ${Math.round(style.emojiRatio * 100)}% of messages use emoji, ` +
    `${Math.round(style.questionRatio * 100)}% contain a question, ` +
    `${Math.round(style.lowercaseRatio * 100)}% all-lowercase, ` +
    `${Math.round(style.noTerminalPunctuationRatio * 100)}% without end punctuation` +
    (style.abbreviations.length > 0
      ? `, uses abbreviations: ${style.abbreviations.slice(0, 5).join(", ")}`
      : "");

  const lines = [
    `CONTACT NAME: ${context.contactName}`,
    context.selfName ? `USER NAME: ${context.selfName}` : "USER NAME: unknown",
    "",
    "USER STYLE:",
    styleLine("user", context.selfStyle),
    styleLine("contact", context.contactStyle),
    "",
    "RECENT MESSAGES (oldest first):",
    ...context.recentMessages.slice(-20).map(format),
    "",
    context.latestIncoming
      ? `MESSAGE TO REPLY TO: ${context.latestIncoming.body}`
      : "MESSAGE TO REPLY TO: none (start a follow-up)",
    "",
    "OPEN THREADS:",
    context.openThreads.length > 0 ? context.openThreads.map((t) => `- ${t}`).join("\n") : "- none",
    "",
    "KNOWN MEMORIES (the only facts you may reference):",
    context.memories.length > 0
      ? context.memories.map((m) => `- [${m.id}] ${m.statement}`).join("\n")
      : "- none",
    "",
    context.tone ? `REQUESTED TONE: ${context.tone}` : "REQUESTED TONE: match the user's style",
    "",
    ...feedbackLines(context.feedback),
    "Produce at most 3 drafts.",
  ];

  return lines.join("\n");
}

/**
 * Validates and screens raw model output.
 *
 * Invalid JSON, schema violations, ungrounded memory references and forbidden
 * phrasings all drop the individual draft rather than failing the whole
 * request — but if nothing survives, `isEmpty` is true and the caller must not
 * persist anything.
 */
export function validateReplyOutput(raw: unknown, context: ReplyContext): ReplyPlan {
  const parsed = replyDraftOutputSchema.safeParse(raw);

  if (!parsed.success) {
    // Keep the reason: a silent empty result is impossible to debug or audit.
    return {
      drafts: [],
      rejected: [
        {
          body: "",
          reason: `Model output failed schema validation: ${
            parsed.error.issues[0]?.message ?? "unknown issue"
          }`,
        },
      ],
      isEmpty: true,
    };
  }

  const output: ReplyDraftOutput = parsed.data;
  const allowedMemoryIds = new Set(context.memories.map((memory) => memory.id));

  const drafts: AcceptedDraft[] = [];
  const rejected: RejectedDraft[] = [];

  for (const candidate of output.drafts) {
    const forbidden = findForbiddenDraftPhrase(candidate.body);
    if (forbidden) {
      rejected.push({ body: candidate.body, reason: forbidden.reason });
      continue;
    }

    // A draft that cites a memory it was not given is hallucinating context.
    const unknownMemory = candidate.usedMemoryIds.find((id) => !allowedMemoryIds.has(id));
    if (unknownMemory) {
      rejected.push({
        body: candidate.body,
        reason: "referenced a memory that was not provided",
      });
      continue;
    }

    drafts.push({
      body: candidate.body.trim(),
      tone: candidate.tone,
      rationale: candidate.rationale,
      usedMemoryIds: candidate.usedMemoryIds,
    });
  }

  return { drafts, rejected, isEmpty: drafts.length === 0 };
}
