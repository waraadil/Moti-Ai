/**
 * Temporal intelligence.
 *
 * Compares the current understanding of a conversation with the previous
 * snapshot so a new import can be described as a *change* rather than a
 * replacement. Pure functions: the comparison is testable without a database,
 * and callers decide what to persist.
 *
 * The snapshot is deliberately a plain, serialisable object so it can be stored
 * as jsonb and diffed years later.
 */

import type { ConversationUnderstanding } from "./understanding";
import type { StyleMetrics } from "./style";

/** New messages needed before an absence is considered meaningful. */
const MIN_MESSAGES_FOR_ABSENCE = 10;

export type ConversationSnapshot = {
  /** ISO instant: only messages at or before this were considered. */
  cutoffAt: string;
  messageCount: number;
  topics: Array<{ label: string; mentions: number }>;
  plans: Array<{ description: string; status: string }>;
  openThreads: string[];
  /** Fingerprints of active memories, so new ones can be identified. */
  memoryFingerprints: string[];
  style: {
    self: { messageCount: number; medianChars: number };
    contact: { messageCount: number; medianChars: number };
  } | null;
};

export type TemporalChange = {
  kind:
    | "new_topic"
    | "topic_gone_quiet"
    | "new_plan"
    | "plan_completed"
    | "plan_cancelled"
    | "new_open_thread"
    | "thread_resolved"
    | "new_memory"
    | "style_shift"
    | "new_messages";
  summary: string;
  /** Message ids backing the change, when applicable. */
  evidenceMessageIds: string[];
};

export type TemporalDiff = {
  hasPrevious: boolean;
  previousCutoffAt: string | null;
  newMessageCount: number;
  changes: TemporalChange[];
};

export function buildSnapshot(params: {
  cutoffAt: string;
  messageCount: number;
  understanding: ConversationUnderstanding;
  style: { self: StyleMetrics; contact: StyleMetrics } | null;
  memoryFingerprints: string[];
}): ConversationSnapshot {
  return {
    cutoffAt: params.cutoffAt,
    messageCount: params.messageCount,
    topics: params.understanding.topics.map((topic) => ({
      label: topic.label,
      mentions: topic.mentions,
    })),
    plans: params.understanding.plans.map((plan) => ({
      description: plan.description,
      status: plan.status,
    })),
    openThreads: params.understanding.openThreads.map((thread) => thread.topic),
    memoryFingerprints: params.memoryFingerprints,
    style: params.style
      ? {
          self: {
            messageCount: params.style.self.messageCount,
            medianChars: params.style.self.medianChars,
          },
          contact: {
            messageCount: params.style.contact.messageCount,
            medianChars: params.style.contact.medianChars,
          },
        }
      : null,
  };
}

function normalisePlan(description: string): string {
  return description
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .slice(0, 80);
}

/**
 * Compares two snapshots.
 *
 * Only reports a change when the evidence supports it: a topic that was merely
 * absent from a short window is not "gone", and a plan is only "completed" when
 * its status explicitly changed to completed.
 */
export function diffSnapshots(
  previous: ConversationSnapshot | null,
  current: ConversationSnapshot,
  currentUnderstanding: ConversationUnderstanding,
): TemporalDiff {
  if (!previous) {
    return {
      hasPrevious: false,
      previousCutoffAt: null,
      newMessageCount: current.messageCount,
      changes: [],
    };
  }

  const changes: TemporalChange[] = [];
  const newMessageCount = Math.max(current.messageCount - previous.messageCount, 0);

  if (newMessageCount > 0) {
    changes.push({
      kind: "new_messages",
      summary: `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"} since the last analysis.`,
      evidenceMessageIds: [],
    });
  }

  // --- Topics ------------------------------------------------------------
  const previousTopics = new Map(previous.topics.map((topic) => [topic.label, topic.mentions]));
  const currentTopics = new Map(current.topics.map((topic) => [topic.label, topic.mentions]));

  for (const [label, mentions] of currentTopics) {
    const before = previousTopics.get(label) ?? 0;
    if (before === 0 && mentions >= 2) {
      changes.push({
        kind: "new_topic",
        summary: `New recurring topic: ${label} (${mentions} mentions).`,
        evidenceMessageIds:
          currentUnderstanding.topics.find((topic) => topic.label === label)?.messageIds ?? [],
      });
    }
  }

  // A topic only counts as "quiet" if it had real presence *and* a meaningful
  // amount of new conversation has happened since. Otherwise a two-message
  // follow-up would claim that a long-running topic disappeared.
  if (newMessageCount >= MIN_MESSAGES_FOR_ABSENCE) {
    for (const [label, mentions] of previousTopics) {
      if (mentions >= 3 && !currentTopics.has(label)) {
        changes.push({
          kind: "topic_gone_quiet",
          summary: `${label} has not come up since the last analysis.`,
          evidenceMessageIds: [],
        });
      }
    }
  }

  // --- Plans -------------------------------------------------------------
  const previousPlans = new Map(
    previous.plans.map((plan) => [normalisePlan(plan.description), plan.status]),
  );

  // Evidence is attached from the live understanding when available, but the
  // comparison itself is driven by the snapshots, which are the durable record.
  const evidenceFor = (description: string): string[] =>
    currentUnderstanding.plans
      .filter((plan) => normalisePlan(plan.description) === normalisePlan(description))
      .flatMap((plan) => plan.citations.map((citation) => citation.messageId));

  for (const plan of current.plans) {
    const key = normalisePlan(plan.description);
    const before = previousPlans.get(key);

    if (before === undefined) {
      changes.push({
        kind: "new_plan",
        summary: `New plan raised: "${plan.description.slice(0, 80)}" (${plan.status}).`,
        evidenceMessageIds: evidenceFor(plan.description),
      });
      continue;
    }

    if (before !== plan.status) {
      if (plan.status === "completed") {
        changes.push({
          kind: "plan_completed",
          summary: `A plan now looks completed: "${plan.description.slice(0, 80)}".`,
          evidenceMessageIds: evidenceFor(plan.description),
        });
      } else if (plan.status === "cancelled") {
        changes.push({
          kind: "plan_cancelled",
          summary: `A plan was cancelled: "${plan.description.slice(0, 80)}".`,
          evidenceMessageIds: evidenceFor(plan.description),
        });
      }
    }
  }

  // --- Open threads ------------------------------------------------------
  const previousThreads = new Set(previous.openThreads);
  const currentThreads = new Set(current.openThreads);

  for (const thread of currentThreads) {
    if (!previousThreads.has(thread)) {
      changes.push({
        kind: "new_open_thread",
        summary: `New unresolved thread: ${thread}.`,
        evidenceMessageIds: [],
      });
    }
  }

  for (const thread of previousThreads) {
    if (!currentThreads.has(thread)) {
      changes.push({
        kind: "thread_resolved",
        summary: `No longer an open thread: ${thread}.`,
        evidenceMessageIds: [],
      });
    }
  }

  // --- Memories ----------------------------------------------------------
  const previousMemories = new Set(previous.memoryFingerprints);
  const newMemories = current.memoryFingerprints.filter(
    (fingerprint) => !previousMemories.has(fingerprint),
  );

  if (newMemories.length > 0) {
    changes.push({
      kind: "new_memory",
      summary: `${newMemories.length} new memor${newMemories.length === 1 ? "y" : "ies"} learned since the last analysis.`,
      evidenceMessageIds: [],
    });
  }

  // --- Style drift -------------------------------------------------------
  if (previous.style && current.style) {
    const shifts: string[] = [];

    const selfDelta = current.style.self.medianChars - previous.style.self.medianChars;
    if (Math.abs(selfDelta) >= 20) {
      shifts.push(
        `Your median message length ${selfDelta > 0 ? "grew" : "shrank"} by ${Math.abs(selfDelta)} characters.`,
      );
    }

    const contactDelta = current.style.contact.medianChars - previous.style.contact.medianChars;
    if (Math.abs(contactDelta) >= 20) {
      shifts.push(
        `Their median message length ${contactDelta > 0 ? "grew" : "shrank"} by ${Math.abs(contactDelta)} characters.`,
      );
    }

    if (shifts.length > 0) {
      changes.push({
        kind: "style_shift",
        summary: shifts.join(" "),
        evidenceMessageIds: [],
      });
    }
  }

  return {
    hasPrevious: true,
    previousCutoffAt: previous.cutoffAt,
    newMessageCount,
    changes,
  };
}
