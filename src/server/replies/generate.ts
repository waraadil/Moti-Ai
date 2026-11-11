/**
 * Reply draft generation.
 *
 * Assembles the context the reply engine needs from *stored* data only — the
 * measured style of both participants, the active memories, the open threads and
 * the recent messages — then runs the provider and validates the result.
 *
 * Two hard rules:
 *   1. A draft is only stored if it survives `validateReplyOutput`, which rejects
 *      promises, invented feelings and ungrounded memory citations.
 *   2. Nothing here can send anything. Drafts are rows for a human to review.
 */

import "server-only";

import { createProvider, PROMPT_VERSION, type ModelIdentity, type ProviderBundle } from "@/lib/ai";
import { analyseConversationStyle, type StyleMetrics } from "@/lib/intelligence/style";
import { understandConversation } from "@/lib/intelligence/understanding";
import {
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  selectUsableMemories,
  validateReplyOutput,
  type ReplyContext,
  type ReplyMemory,
} from "@/lib/intelligence/reply";
import { parseJsonResponse, replyDraftOutputSchema } from "@/lib/intelligence/schemas";
import type { AnalysisMessage } from "@/lib/intelligence/types";
import type { MessageRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { latestVersion } from "@/server/analysis/repository";
import { isEmptyFeedback, loadReplyFeedback } from "./preferences";
import type { ReplyFeedback } from "@/lib/intelligence/reply";
import { listMemories } from "@/server/memories/repository";
import { listMessages } from "@/server/messages/repository";
import { replaceOpenDrafts, type NewReplyDraft } from "@/server/replies/repository";

/** How many recent messages are shown to the generator as immediate context. */
const RECENT_WINDOW = 12;

export type GenerateDraftsResult = {
  status: "created" | "no_incoming" | "no_analysis" | "empty" | "failed";
  drafts: number;
  rejected: number;
  problem: string | null;
  identity: ModelIdentity | null;
};

export type GenerateDraftsParams = {
  userId: string;
  contactId: string;
  contactName: string;
  selfName: string | null;
  supabase: ServerSupabaseClient;
  tone?: string | null;
  provider?: ProviderBundle;
};

/** Whitespace- and case-insensitive form, used only for duplicate detection. */
function normaliseForComparison(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Loads only the tail of the conversation: reply drafting needs recency, not history. */
async function loadRecentMessages(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<MessageRow[]> {
  const page = await listMessages(supabase, userId, contactId, { limit: 200, offset: 0 });
  return page.messages;
}

export async function generateReplyDrafts(
  params: GenerateDraftsParams,
): Promise<GenerateDraftsResult> {
  const { supabase, userId, contactId } = params;

  // A reply needs the analysis to exist: style and memories come from it.
  const version = await latestVersion(supabase, userId, contactId, "memory_extraction");
  if (!version) {
    return {
      status: "no_analysis",
      drafts: 0,
      rejected: 0,
      problem: "Analyse this conversation before generating replies.",
      identity: null,
    };
  }

  const rows = await loadRecentMessages(supabase, userId, contactId);
  if (rows.length === 0) {
    return {
      status: "no_incoming",
      drafts: 0,
      rejected: 0,
      problem: "There are no messages to reply to yet.",
      identity: null,
    };
  }

  const input = toAnalysisInput(rows, {
    contactName: params.contactName,
    selfName: params.selfName,
  });

  // The draft answers the most recent incoming message. Drafting a reply to an
  // older message is legitimate — the user may want alternatives — but with no
  // incoming message at all there is nothing to answer, and inventing one would
  // be guessing.
  const latestIncoming = [...input.messages]
    .reverse()
    .find((message) => message.participant === "contact" && message.kind === "text");

  if (!latestIncoming) {
    return {
      status: "no_incoming",
      drafts: 0,
      rejected: 0,
      problem: "This conversation has no incoming messages to reply to.",
      identity: null,
    };
  }

  const style = analyseConversationStyle(input.messages);
  const understanding = understandConversation(input.messages);

  const memoryRows = await listMemories(supabase, userId, contactId, {
    status: "active",
    limit: 40,
  });

  const memories: ReplyMemory[] = memoryRows.map((memory) => ({
    id: memory.id,
    statement: memory.statement,
    confidence: memory.confidence,
    isUserConfirmed: memory.is_user_confirmed,
  }));

  let context: ReplyContext = {
    contactName: params.contactName,
    selfName: params.selfName,
    latestIncoming,
    recentMessages: input.messages.slice(-RECENT_WINDOW),
    selfStyle: style.self,
    contactStyle: style.contact,
    openThreads: understanding.openThreads.map((thread) => thread.topic),
    memories: selectUsableMemories(memories),
    tone: params.tone ?? null,
  };

  /*
   * Load what the user did with earlier suggestions. A failure here must not
   * break drafting: preferences improve quality, they are not correctness.
   */
  let feedback: ReplyFeedback | undefined;
  try {
    feedback = await loadReplyFeedback(supabase, userId, contactId);
    if (isEmptyFeedback(feedback)) feedback = undefined;
  } catch (error) {
    console.error("[moti] could not load reply feedback", error);
  }

  if (feedback) context = { ...context, feedback };

  const bundle = params.provider ?? createProvider();
  const identity: ModelIdentity =
    bundle.kind === "deterministic"
      ? { provider: "deterministic", model: "moti-rules-v1" }
      : { provider: bundle.provider.identity.provider, model: bundle.provider.identity.model };

  let raw: string;
  try {
    // The rule engine needs the structured context, not just prompt text.
    if (bundle.kind === "deterministic") {
      bundle.provider.withTask({
        kind: "reply",
        input,
        payload: {
          contactName: context.contactName,
          selfName: context.selfName,
          latestIncoming: context.latestIncoming?.body ?? null,
          style: context.selfStyle as StyleMetrics,
          memories: context.memories.map((memory) => ({
            id: memory.id,
            statement: memory.statement,
          })),
          openThreads: context.openThreads,
        },
      });
    }

    const response = await bundle.provider.complete({
      system: buildReplySystemPrompt(),
      messages: [{ role: "user", content: buildReplyUserPrompt(context) }],
      maxTokens: 2048,
      expectJson: true,
    });
    raw = response.text;
  } catch (error) {
    return {
      status: "failed",
      drafts: 0,
      rejected: 0,
      problem: error instanceof Error ? error.message : "The provider call failed.",
      identity,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = parseJsonResponse(raw);
  } catch {
    return {
      status: "failed",
      drafts: 0,
      rejected: 0,
      problem: "The provider returned output that was not JSON.",
      identity,
    };
  }

  const schemaResult = replyDraftOutputSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return {
      status: "failed",
      drafts: 0,
      rejected: 0,
      problem: `The provider output failed validation: ${
        schemaResult.error.issues[0]?.message ?? "unknown issue"
      }`,
      identity,
    };
  }

  // Safety gate: forbidden phrases and ungrounded citations are dropped here.
  const plan = validateReplyOutput(schemaResult.data, context);

  /*
   * Drop drafts the user already discarded for this contact. Re-offering a
   * reply someone explicitly threw away is the clearest sign Moti is ignoring
   * them; it is cheaper and more honest to stay quiet than to repeat it.
   * Comparison is normalised (whitespace and case) so a trivial difference
   * cannot smuggle the same text back in.
   */
  const rejectedBodies = new Set(
    (feedback?.rejected ?? []).map((rejected) => normaliseForComparison(rejected.body)),
  );
  if (rejectedBodies.size > 0) {
    plan.drafts = plan.drafts.filter(
      (draft) => !rejectedBodies.has(normaliseForComparison(draft.body)),
    );
  }

  if (plan.drafts.length === 0) {
    return {
      status: "empty",
      drafts: 0,
      rejected: plan.rejected.length,
      problem:
        plan.rejected[0]?.reason ??
        "No draft survived validation. Nothing was saved rather than offer a risky suggestion.",
      identity,
    };
  }

  const newDrafts: NewReplyDraft[] = plan.drafts.map((draft) => ({
    userId,
    contactId,
    analysisVersionId: version.id,
    inReplyToMessageId: latestIncoming.id,
    body: draft.body,
    tone: draft.tone,
    usedMemoryIds: draft.usedMemoryIds,
    modelProvider: identity.provider,
    modelName: identity.model,
    promptVersion: PROMPT_VERSION,
  }));

  const stored = await replaceOpenDrafts(supabase, newDrafts);

  return {
    status: "created",
    drafts: stored.length,
    rejected: plan.rejected.length,
    problem: null,
    identity,
  };
}

/** Re-exported for the page. */
export type { AnalysisMessage };
