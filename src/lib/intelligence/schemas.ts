/**
 * Zod schemas for every analysis output.
 *
 * Model output is untrusted text. Nothing reaches the database until it has
 * passed through these schemas, and the same schemas validate the deterministic
 * analyser, so both providers are held to one contract.
 */

import { z } from "zod";

export const MEMORY_CATEGORIES = [
  "preference",
  "life_event",
  "relationship",
  "boundary",
  "goal",
  "routine",
  "sensitive",
] as const;

export const EVIDENCE_STATUSES = ["direct", "inferred"] as const;

/**
 * A single memory proposed by the analyser.
 *
 * `evidence` must be non-empty: a memory without a citation is not accepted,
 * which is what stops the model from inventing personal details.
 */
export const memoryCandidateSchema = z.object({
  statement: z.string().trim().min(8, "A memory statement must be a readable sentence.").max(400),
  category: z.enum(MEMORY_CATEGORIES),
  /** Which side of the conversation the fact is about. */
  about: z.enum(["contact", "self", "shared"]),
  details: z.string().trim().max(2000).optional(),
  topics: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  evidenceStatus: z.enum(EVIDENCE_STATUSES),
  confidence: z.number().min(0).max(1),
  isSensitive: z.boolean().default(false),
  /** Message ids that justify this statement. At least one is required. */
  evidenceMessageIds: z.array(z.string().min(1)).min(1).max(5),
});

export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;

export const memoryExtractionOutputSchema = z.object({
  memories: z.array(memoryCandidateSchema).max(60),
  /** Things the model noticed but would not assert. Surfaced, never stored as fact. */
  uncertainObservations: z
    .array(
      z.object({
        observation: z.string().trim().min(5).max(400),
        reason: z.string().trim().min(5).max(400),
        evidenceMessageIds: z.array(z.string().min(1)).max(5).default([]),
      }),
    )
    .max(20)
    .default([]),
});

export type MemoryExtractionOutput = z.infer<typeof memoryExtractionOutputSchema>;

// --------------------------------------------------------------------------
// Style narration
// --------------------------------------------------------------------------
// Metric computation is deterministic (see style.ts); the model is only used to
// phrase them, and its prose is rejected if it contradicts the metrics.

export const styleNarrationOutputSchema = z.object({
  selfSummary: z.string().trim().min(10).max(800),
  contactSummary: z.string().trim().min(10).max(800),
  /** Observable differences, each tied to a metric name from style.ts. */
  contrasts: z
    .array(
      z.object({
        metric: z.string().trim().min(2).max(60),
        observation: z.string().trim().min(5).max(300),
      }),
    )
    .max(8)
    .default([]),
});

export type StyleNarrationOutput = z.infer<typeof styleNarrationOutputSchema>;

// --------------------------------------------------------------------------
// Conversation understanding narration
// --------------------------------------------------------------------------

export const conversationSummaryOutputSchema = z.object({
  summary: z.string().trim().min(20).max(2000),
  /** Topics the model considers recurring; validated against detected topics. */
  recurringTopics: z.array(z.string().trim().min(2).max(60)).max(15).default([]),
  importantDetails: z
    .array(
      z.object({
        detail: z.string().trim().min(3).max(300),
        evidenceMessageIds: z.array(z.string().min(1)).min(1).max(3),
      }),
    )
    .max(20)
    .default([]),
});

export type ConversationSummaryOutput = z.infer<typeof conversationSummaryOutputSchema>;

// --------------------------------------------------------------------------
// Reply drafts
// --------------------------------------------------------------------------

export const replyDraftOutputSchema = z.object({
  drafts: z
    .array(
      z.object({
        body: z.string().trim().min(1).max(1200),
        tone: z.string().trim().min(2).max(40),
        /** Why this draft fits the conversation. */
        rationale: z.string().trim().min(5).max(500),
        /** Memory ids the draft relied on. Must be a subset of what was supplied. */
        usedMemoryIds: z.array(z.string().min(1)).max(10).default([]),
      }),
    )
    .min(1)
    .max(3),
});

export type ReplyDraftOutput = z.infer<typeof replyDraftOutputSchema>;

/**
 * Suggestions phrased as commitments are rejected.
 *
 * A draft must not promise, confess, or assert a feeling on the user's behalf —
 * that is the single most damaging failure mode for this feature.
 */
const FORBIDDEN_DRAFT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bi (?:promise|swear|guarantee)\b/i, reason: "makes a promise on the user's behalf" },
  {
    pattern: /\bi (?:love|miss|adore|hate) (?:you|u)\b/i,
    reason: "asserts a feeling on the user's behalf",
  },
  {
    pattern: /\bi(?:'m| am) (?:sorry|proud|grateful|upset|angry|happy|sad)\b/i,
    reason: "asserts an emotional state on the user's behalf",
  },
  {
    pattern: /\bi(?:'ll| will) (?:pay|send|book|buy|transfer)\b/i,
    reason: "commits the user to an action",
  },
];

export function findForbiddenDraftPhrase(body: string): { phrase: string; reason: string } | null {
  for (const rule of FORBIDDEN_DRAFT_PATTERNS) {
    const match = rule.pattern.exec(body);
    if (match) return { phrase: match[0], reason: rule.reason };
  }
  return null;
}

/** Parses JSON returned by a model, with a clear error when it is malformed. */
export function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();

  // Models sometimes wrap JSON in a fenced block despite instructions.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}
