/**
 * Participant intelligence.
 *
 * Decides which side of the conversation each message belongs to. Attribution is
 * never guessed here: the only inputs are the labels the user explicitly
 * confirmed during import, so this module's job is to apply that mapping
 * consistently and to refuse anything it cannot attribute.
 */

import type { AnalysisMessage, ConversationInput } from "./types";

export type ParticipantResolution = {
  /** Labels confirmed as belonging to the Moti user. */
  selfLabels: string[];
  /** The participant that is not the user, or null if it cannot be determined. */
  contactLabel: string | null;
  /** Distinct labels observed in the stored messages. */
  observedLabels: string[];
  /** Labels present in messages but absent from the confirmed mapping. */
  unmappedLabels: string[];
  /** True when attribution is trustworthy enough to analyse. */
  isUsable: boolean;
  problem: string | null;
};

/**
 * Derives the participant mapping from the messages themselves.
 *
 * `direction` was decided at import time from the user's confirmation, so a
 * message marked `outgoing` is by definition from the user. The labels attached
 * to those messages *are* the confirmed self labels — no re-guessing needed.
 */
export function resolveParticipants(input: ConversationInput): ParticipantResolution {
  const selfLabelSet = new Set<string>();
  const otherLabelSet = new Set<string>();
  const observed = new Set<string>();

  for (const message of input.messages) {
    if (message.participant === "system" || !message.senderLabel) continue;

    observed.add(message.senderLabel);

    if (message.participant === "self") selfLabelSet.add(message.senderLabel);
    else if (message.participant === "contact") otherLabelSet.add(message.senderLabel);
  }

  const selfLabels = [...selfLabelSet];
  const others = [...otherLabelSet];

  // A label cannot be attributed to both sides; that would mean the import
  // stored contradictory attribution.
  const conflict = selfLabels.filter((label) =>
    others.some((other) => other.toLowerCase() === label.toLowerCase()),
  );

  if (conflict.length > 0) {
    return {
      selfLabels,
      contactLabel: null,
      observedLabels: [...observed],
      unmappedLabels: conflict,
      isUsable: false,
      problem:
        `The label "${conflict[0]}" appears on both sides of the conversation. ` +
        "That means the sender mapping is wrong, so no analysis was produced.",
    };
  }

  if (selfLabels.length === 0) {
    return {
      selfLabels: [],
      contactLabel: null,
      observedLabels: [...observed],
      unmappedLabels: [],
      isUsable: false,
      problem:
        "None of the stored messages are attributed to you, so there is no way to " +
        "compare your style with this contact's. Confirm the sender mapping for this import.",
    };
  }

  if (others.length === 0) {
    return {
      selfLabels,
      contactLabel: null,
      observedLabels: [...observed],
      unmappedLabels: [],
      isUsable: false,
      problem: `Every stored message is attributed to you, so there is nothing from ${input.contactName}.`,
    };
  }

  if (others.length > 1) {
    return {
      selfLabels,
      contactLabel: null,
      observedLabels: [...observed],
      unmappedLabels: others,
      isUsable: false,
      problem:
        `Messages are attributed to ${others.length} different people (${others.join(", ")}), ` +
        "but this conversation should have one contact. Check the sender mapping.",
    };
  }

  return {
    selfLabels,
    contactLabel: others[0] as string,
    observedLabels: [...observed],
    unmappedLabels: [],
    isUsable: true,
    problem: null,
  };
}

/** Splits messages by side, dropping system rows and empty bodies. */
export function splitByParticipant(
  messages: readonly AnalysisMessage[],
): Record<"self" | "contact", AnalysisMessage[]> {
  const self: AnalysisMessage[] = [];
  const contact: AnalysisMessage[] = [];

  for (const message of messages) {
    if (message.participant === "system") continue;
    if (message.kind !== "text") continue;
    if (!message.body.trim()) continue;

    if (message.participant === "self") self.push(message);
    else contact.push(message);
  }

  return { self, contact };
}
