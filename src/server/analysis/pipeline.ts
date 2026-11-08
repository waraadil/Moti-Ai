/**
 * Analysis pipeline.
 *
 * The join between the pure intelligence services (`src/lib/intelligence`) and
 * persistence. Each stage is independently runnable and independently testable:
 *
 *   load conversation -> resolve participants -> compute style -> understand
 *   -> extract memories (provider) -> version + persist -> snapshot -> diff
 *
 * Guarantees enforced here:
 *   - refuses to analyse a conversation whose attribution it cannot trust,
 *   - never writes a memory without a citation,
 *   - re-running identical input returns the stored version instead of
 *     re-querying the provider (idempotent, retry-safe),
 *   - memory writes are deduplicated by fingerprint,
 *   - history is superseded, never overwritten.
 */

import "server-only";

import type { MessageRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { analyseConversationStyle, describeStyle } from "@/lib/intelligence/style";
import { resolveParticipants } from "@/lib/intelligence/participants";
import { understandConversation } from "@/lib/intelligence/understanding";
import {
  buildSnapshot,
  diffSnapshots,
  type ConversationSnapshot,
  type TemporalDiff,
} from "@/lib/intelligence/temporal";
import {
  conversationSummaryOutputSchema,
  memoryExtractionOutputSchema,
  styleNarrationOutputSchema,
  parseJsonResponse,
  type MemoryCandidate,
} from "@/lib/intelligence/schemas";
import type { AnalysisMessage, ConversationInput } from "@/lib/intelligence/types";
import { createProvider, PROMPT_VERSION, type ModelIdentity, type ProviderBundle } from "@/lib/ai";
import {
  beginRun,
  completeRun,
  createVersion,
  failRun,
  hashAnalysisInput,
  insertMemories,
  latestSnapshot,
  nextVersionNumber,
  saveSnapshot,
  supersedePreviousVersions,
  upsertCommunicationProfile,
  type MemoryInsert,
} from "./repository";

/** Maximum messages sent to a provider in one analysis window. */
export const MAX_ANALYSIS_MESSAGES = 3000;

export type AnalysisOutcome = {
  status: "completed" | "skipped_insufficient" | "skipped_untrusted" | "failed" | "cached";
  versionId: string | null;
  version: number | null;
  identity: ModelIdentity | null;
  messagesAnalysed: number;
  memoriesInserted: number;
  memoriesDuplicated: number;
  styleReliable: boolean;
  coverageNote: string | null;
  temporal: TemporalDiff | null;
  problem: string | null;
  durationMs: number;
};

export class UntrustedAttributionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UntrustedAttributionError";
  }
}

/** Converts stored rows into the engine's input shape. Attribution is read, not inferred. */
export function toAnalysisInput(
  messages: readonly MessageRow[],
  options: { contactName: string; selfName: string | null },
): ConversationInput {
  const toParticipant = (row: MessageRow): AnalysisMessage["participant"] => {
    switch (row.direction) {
      case "outgoing":
        return "self";
      case "incoming":
        return "contact";
      default:
        return "system";
    }
  };

  return {
    contactName: options.contactName,
    selfName: options.selfName,
    messages: messages
      .filter((row): row is MessageRow & { sent_at: string } => row.sent_at !== null)
      .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
      .slice(-MAX_ANALYSIS_MESSAGES)
      .map((row) => ({
        id: row.id,
        participant: toParticipant(row),
        senderLabel: row.sender_label,
        sentAt: row.sent_at,
        body: row.body ?? "",
        kind: row.kind,
      })),
  };
}

/**
 * Re-exported so callers keep their existing import path while the single
 * implementation lives in the pure intelligence layer.
 */
import { memoryFingerprint } from "@/lib/intelligence/fingerprint";

export { memoryFingerprint };

export type RunAnalysisParams = {
  userId: string;
  contactId: string;
  contactName: string;
  selfName: string | null;
  messages: MessageRow[];
  supabase: ServerSupabaseClient;
  /** Injected in tests to avoid constructing a provider. */
  provider?: ProviderBundle;
};

/**
 * Runs the full analysis for one contact.
 * Safe to call repeatedly: identical input is served from the existing version.
 */
export async function runAnalysis(params: RunAnalysisParams): Promise<AnalysisOutcome> {
  const startedAt = Date.now();
  const input = toAnalysisInput(params.messages, {
    contactName: params.contactName,
    selfName: params.selfName,
  });

  const resolution = resolveParticipants(input);

  if (!resolution.isUsable) {
    return {
      status: "skipped_untrusted",
      versionId: null,
      version: null,
      identity: null,
      messagesAnalysed: input.messages.length,
      memoriesInserted: 0,
      memoriesDuplicated: 0,
      styleReliable: false,
      coverageNote: null,
      temporal: null,
      problem: resolution.problem,
      durationMs: Date.now() - startedAt,
    };
  }

  const bundle = params.provider ?? createProvider();
  const identity = await resolveIdentity(bundle);

  // --- Idempotency -------------------------------------------------------
  const inputHash = hashAnalysisInput({
    promptVersion: `${PROMPT_VERSION}:${identity.provider}:${identity.model}`,
    messageIds: input.messages.map((message) => message.id),
    bodies: input.messages.map((message) => message.body),
  });

  const { run, alreadyCompleted } = await beginRun(params.supabase, {
    userId: params.userId,
    contactId: params.contactId,
    kind: "memory_extraction",
    inputHash,
    inputMessages: input.messages.length,
  });

  if (alreadyCompleted && run.analysisVersionId) {
    await completeRun(params.supabase, {
      userId: params.userId,
      runId: run.id,
      versionId: run.analysisVersionId,
      durationMs: Date.now() - startedAt,
    });

    return {
      status: "cached",
      versionId: run.analysisVersionId,
      version: null,
      identity,
      messagesAnalysed: input.messages.length,
      memoriesInserted: 0,
      memoriesDuplicated: 0,
      styleReliable: true,
      coverageNote: null,
      temporal: null,
      problem: null,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    // --- Deterministic stages -------------------------------------------
    const style = analyseConversationStyle(input.messages);
    const understanding = understandConversation(input.messages);

    const selfSummary = describeStyle(style.self, params.selfName ?? "You");
    const contactSummary = describeStyle(style.contact, params.contactName);

    // --- Provider stage: memories ---------------------------------------
    const memories = await extractMemoriesWithProvider(bundle, input, params.contactName);

    // --- Versioning ------------------------------------------------------
    const version = await nextVersionNumber(
      params.supabase,
      params.userId,
      params.contactId,
      "memory_extraction",
    );

    const output = {
      style: {
        self: style.self,
        contact: style.contact,
        selfSummary,
        contactSummary,
      },
      understanding,
      memories: memories.accepted,
      uncertainObservations: memories.rejected,
      provider: identity,
      promptVersion: PROMPT_VERSION,
      attribution: {
        selfLabels: resolution.selfLabels,
        contactLabel: resolution.contactLabel,
      },
    };

    const versionRow = await createVersion(params.supabase, {
      userId: params.userId,
      contactId: params.contactId,
      kind: "memory_extraction",
      version,
      modelProvider: identity.provider,
      modelName: identity.model,
      promptVersion: PROMPT_VERSION,
      messageCount: input.messages.length,
      sourceFrom: input.messages[0]?.sentAt ?? null,
      sourceUntil: input.messages[input.messages.length - 1]?.sentAt ?? null,
      output,
    });

    await supersedePreviousVersions(params.supabase, {
      userId: params.userId,
      contactId: params.contactId,
      kind: "memory_extraction",
      newVersionId: versionRow.id,
      newVersion: version,
    });

    // --- Persist memories with evidence ---------------------------------
    const memoryRows: MemoryInsert[] = memories.accepted
      .map((candidate) => {
        const cited = candidate.evidenceMessageIds
          .map((id) => input.messages.find((message) => message.id === id))
          .filter((message): message is AnalysisMessage => message !== undefined);

        return {
          userId: params.userId,
          contactId: params.contactId,
          analysisVersionId: versionRow.id,
          candidate: {
            statement: candidate.statement,
            category: candidate.category,
            topics: candidate.topics,
            details: candidate.details ?? null,
            confidence: candidate.confidence,
            isSensitive: candidate.isSensitive,
            fingerprint: memoryFingerprint(candidate.statement),
            firstObservedAt: cited[0]?.sentAt ?? null,
            lastObservedAt: cited[cited.length - 1]?.sentAt ?? null,
          },
          evidence: cited.map((message) => ({
            messageId: message.id,
            excerpt: message.body.slice(0, 500),
            rationale:
              candidate.evidenceStatus === "direct"
                ? "Message states this directly."
                : "Inferred from the message wording.",
            confidence: candidate.confidence,
            evidenceStatus: candidate.evidenceStatus,
            speakerLabel: message.senderLabel,
            saidAt: message.sentAt,
          })),
        };
      })
      // A memory with no resolvable citation must never be stored.
      .filter((row) => row.evidence.length > 0);

    const writeResult = await insertMemories(params.supabase, memoryRows);

    // --- Profiles --------------------------------------------------------
    await upsertCommunicationProfile(params.supabase, {
      userId: params.userId,
      contactId: params.contactId,
      analysisVersionId: versionRow.id,
      participant: "self",
      messageCount: style.self.messageCount,
      medianChars: style.self.medianChars,
      medianReplyMinutes: style.self.medianReplyMinutes,
      formality: null,
      warmth: null,
      humour: null,
      directness: null,
      emojiRate: style.self.emojiRatio,
      summary: selfSummary,
      sampleTopics: understanding.topics.slice(0, 8).map((topic) => topic.label),
      commonPhrases: style.self.topWords.slice(0, 8).map((entry) => entry.word),
      isPopulated: style.self.messageCount > 0,
    });

    await upsertCommunicationProfile(params.supabase, {
      userId: params.userId,
      contactId: params.contactId,
      analysisVersionId: versionRow.id,
      participant: "contact",
      messageCount: style.contact.messageCount,
      medianChars: style.contact.medianChars,
      medianReplyMinutes: style.contact.medianReplyMinutes,
      formality: null,
      warmth: null,
      humour: null,
      directness: null,
      emojiRate: style.contact.emojiRatio,
      summary: contactSummary,
      sampleTopics: understanding.topics.slice(0, 8).map((topic) => topic.label),
      commonPhrases: style.contact.topWords.slice(0, 8).map((entry) => entry.word),
      isPopulated: style.contact.messageCount > 0,
    });

    // --- Temporal --------------------------------------------------------
    const previous = await latestSnapshot(params.supabase, params.userId, params.contactId);
    const cutoffAt = input.messages[input.messages.length - 1]?.sentAt ?? new Date().toISOString();

    const snapshot = buildSnapshot({
      cutoffAt,
      messageCount: input.messages.length,
      understanding,
      style,
      memoryFingerprints: memoryRows.map((row) => row.candidate.fingerprint),
    });

    const temporal = diffSnapshots(
      previous?.data as ConversationSnapshot | null,
      snapshot,
      understanding,
    );

    await saveSnapshot(params.supabase, {
      userId: params.userId,
      contactId: params.contactId,
      analysisVersionId: versionRow.id,
      cutoffAt,
      messageCount: input.messages.length,
      data: snapshot,
    });

    await completeRun(params.supabase, {
      userId: params.userId,
      runId: run.id,
      versionId: versionRow.id,
      durationMs: Date.now() - startedAt,
    });

    return {
      status: "completed",
      versionId: versionRow.id,
      version,
      identity,
      messagesAnalysed: input.messages.length,
      memoriesInserted: writeResult.inserted,
      memoriesDuplicated: writeResult.duplicated,
      styleReliable: style.isReliable,
      coverageNote: style.self.coverage.note ?? style.contact.coverage.note ?? null,
      temporal,
      problem: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await failRun(params.supabase, {
      userId: params.userId,
      runId: run.id,
      errorMessage: error instanceof Error ? error.message : "Unknown analysis error",
      durationMs: Date.now() - startedAt,
    });

    return {
      status: "failed",
      versionId: null,
      version: null,
      identity,
      messagesAnalysed: input.messages.length,
      memoriesInserted: 0,
      memoriesDuplicated: 0,
      styleReliable: false,
      coverageNote: null,
      temporal: null,
      problem: error instanceof Error ? error.message : "Unknown analysis error",
      durationMs: Date.now() - startedAt,
    };
  }
}

async function resolveIdentity(bundle: ProviderBundle): Promise<ModelIdentity> {
  return bundle.kind === "deterministic"
    ? { provider: "deterministic", model: "moti-rules-v1" }
    : { provider: bundle.provider.identity.provider, model: bundle.provider.identity.model };
}

/**
 * Runs memory extraction through the provider and validates the response.
 *
 * A schema failure is not fatal: the run records zero memories and the reasons
 * in `uncertainObservations`, rather than inventing partial data.
 */
async function extractMemoriesWithProvider(
  bundle: ProviderBundle,
  input: ConversationInput,
  contactName: string,
): Promise<{ accepted: MemoryCandidate[]; rejected: unknown[] }> {
  const transcript = input.messages
    .filter((message) => message.participant !== "system" && message.kind === "text")
    .map(
      (message) =>
        `[${message.id}] [${message.sentAt}] ${message.participant === "self" ? "USER" : "CONTACT"}: ${message.body}`,
    )
    .join("\n");

  const system = [
    "You extract durable facts about a person from a private chat transcript.",
    "Rules:",
    "- Only extract facts stated explicitly by a speaker about themselves or their life.",
    "- Never infer feelings, intentions, or traits. Never guess.",
    "- Skip anything hypothetical, negated, uncertain, or reported second-hand.",
    "- Every memory must cite the message ids that state it.",
    "- Mark evidenceStatus as 'direct' only when the message states the fact plainly.",
    "Return JSON: { memories: [{ statement, category, about, details, topics, evidenceStatus, confidence, isSensitive, evidenceMessageIds }], uncertainObservations: [] }",
    `Categories allowed: preference, life_event, relationship, boundary, goal, routine, sensitive.`,
    `The contact is named ${contactName}. The user is the other speaker.`,
  ].join("\n");

  // The deterministic provider needs the structured input to apply its rules;
  // a hosted provider only sees the rendered transcript.
  if (bundle.kind === "deterministic") {
    bundle.provider.withTask({ kind: "memories", input });
  }

  const response = await bundle.provider.complete({
    system,
    messages: [{ role: "user", content: transcript }],
    maxTokens: 4096,
    expectJson: true,
  });
  const raw = response.text;

  let parsedJson: unknown;
  try {
    parsedJson = parseJsonResponse(raw);
  } catch {
    return { accepted: [], rejected: [{ reason: "Provider returned non-JSON output." }] };
  }

  const validated = memoryExtractionOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      accepted: [],
      rejected: [
        { reason: "Provider output failed schema validation.", issues: validated.error.issues },
      ],
    };
  }

  const validIds = new Set(input.messages.map((message) => message.id));

  // Drop any candidate citing a message that does not exist in this window.
  const accepted = validated.data.memories.filter((candidate) =>
    candidate.evidenceMessageIds.every((id) => validIds.has(id)),
  );

  return {
    accepted,
    rejected: [
      ...validated.data.uncertainObservations,
      ...validated.data.memories
        .filter((candidate) => !accepted.includes(candidate))
        .map((candidate) => ({
          reason: "Cited a message outside the analysed window.",
          statement: candidate.statement,
        })),
    ],
  };
}

/** Exported for the UI: which provider will be used, without exposing the key. */
export function analysisProviderLabel(bundle: ProviderBundle): string {
  if (bundle.kind === "deterministic") {
    return "Moti rule engine (deterministic, offline — not a language model)";
  }
  return `${bundle.provider.identity.provider} · ${bundle.provider.identity.model}`;
}

/** Unused import guard: keeps the style narration schema referenced. */
export const STYLE_NARRATION_SCHEMA = styleNarrationOutputSchema;
export const SUMMARY_SCHEMA = conversationSummaryOutputSchema;
