/**
 * Conversation understanding.
 *
 * Extracts what the conversation is about, using rules that can be pointed at
 * concrete messages. Every extracted item keeps the message IDs, speaker label
 * and timestamp it came from, and is tagged `direct` (the text says it) or
 * `inferred` (a rule read it from surrounding signals).
 *
 * There is no generative step here, so nothing can be invented: if a plan is
 * reported, a message contains the plan.
 */

import type { AnalysisMessage } from "./types";

export type EvidenceStatus = "direct" | "inferred";

/** A single citation back to the export. */
export type Citation = {
  messageId: string;
  /** Original sender label, preserved verbatim. */
  speakerLabel: string | null;
  /** Which side said it, from the confirmed mapping. */
  participant: "self" | "contact";
  saidAt: string;
  /** Verbatim excerpt, never paraphrased. */
  excerpt: string;
};

export type Topic = {
  label: string;
  /** How many messages mention it. */
  mentions: number;
  /** Message ids, chronological. */
  messageIds: string[];
  firstMentionedAt: string;
  lastMentionedAt: string;
  /** Topic detection is keyword-based, so this is always inferred. */
  status: EvidenceStatus;
};

export type Plan = {
  description: string;
  /** Who proposed or committed to it. */
  participant: "self" | "contact" | "both";
  /** ISO date when the plan refers to, if stated. */
  scheduledFor: string | null;
  status: "proposed" | "agreed" | "completed" | "cancelled" | "unclear";
  citations: Citation[];
  status_: EvidenceStatus;
};

export type Question = {
  text: string;
  askedBy: "self" | "contact";
  messageId: string;
  askedAt: string;
  /** True when nobody replied with an answer-shaped message afterwards. */
  appearsUnanswered: boolean;
};

export type OpenThread = {
  topic: string;
  /** Why it is considered open. */
  reason: string;
  citations: Citation[];
  lastActivityAt: string;
  status_: EvidenceStatus;
};

export type ConversationUnderstanding = {
  topics: Topic[];
  plans: Plan[];
  questions: Question[];
  openThreads: OpenThread[];
  /** Key details: dates, places, numbers the participants mention. */
  details: Array<{
    kind: "date" | "time" | "money" | "quantity";
    value: string;
    citation: Citation;
  }>;
  messageCount: number;
};

// --- Topic vocabulary ------------------------------------------------------
// Explicit keyword groups rather than free-form keyword extraction, so a topic
// label is always a curated, human-readable category and never a random token.

const TOPIC_RULES: Array<{ label: string; keywords: string[] }> = [
  {
    label: "work",
    keywords: [
      "work",
      "job",
      "office",
      "boss",
      "shift",
      "meeting",
      "deadline",
      "project",
      "interview",
      "salary",
      "client",
    ],
  },
  {
    label: "family",
    keywords: [
      "mum",
      "mom",
      "dad",
      "mother",
      "father",
      "sister",
      "brother",
      "parents",
      "aunt",
      "uncle",
      "cousin",
      "grandma",
      "grandpa",
      "family",
    ],
  },
  {
    label: "travel",
    keywords: [
      "trip",
      "flight",
      "travel",
      "holiday",
      "vacation",
      "airport",
      "hotel",
      "abroad",
      "lisbon",
      "train",
      "booking",
    ],
  },
  {
    label: "food",
    keywords: [
      "dinner",
      "lunch",
      "breakfast",
      "eat",
      "food",
      "restaurant",
      "cook",
      "cake",
      "coffee",
      "pizza",
      "recipe",
    ],
  },
  {
    label: "health",
    keywords: [
      "doctor",
      "hospital",
      "sick",
      "ill",
      "medicine",
      "gym",
      "run",
      "running",
      "marathon",
      "training",
      "injury",
      "sleep",
      "therapy",
    ],
  },
  {
    label: "social",
    keywords: [
      "party",
      "birthday",
      "wedding",
      "drinks",
      "meet",
      "meeting up",
      "saturday",
      "sunday",
      "weekend",
      "friends",
    ],
  },
  {
    label: "money",
    keywords: [
      "pay",
      "paid",
      "rent",
      "money",
      "cost",
      "price",
      "bill",
      "owe",
      "budget",
      "invoice",
      "expensive",
    ],
  },
  {
    label: "study",
    keywords: [
      "exam",
      "university",
      "course",
      "study",
      "revision",
      "assignment",
      "lecture",
      "school",
      "degree",
    ],
  },
  {
    label: "housing",
    keywords: [
      "flat",
      "house",
      "move",
      "moving",
      "landlord",
      "rent",
      "room",
      "mortgage",
      "apartment",
    ],
  },
  {
    label: "technology",
    keywords: ["laptop", "phone", "app", "code", "software", "computer", "bug", "deploy", "server"],
  },
];

const PLAN_KEYWORDS = [
  "let's",
  "lets",
  "we should",
  "shall we",
  "i'll",
  "i will",
  "we'll",
  "we will",
  "planning to",
  "plan to",
  "going to",
  "book",
  "booked",
  "arrange",
  "meet at",
  "see you",
  "come over",
  "pick you up",
  "i'm going to",
  "im going to",
];

const AGREEMENT_WORDS = [
  "yes",
  "yeah",
  "sure",
  "ok",
  "okay",
  "sounds good",
  "perfect",
  "deal",
  "confirmed",
  "agreed",
  "definitely",
  "count me in",
];
const CANCELLATION_WORDS = [
  "cancel",
  "cancelled",
  "canceled",
  "can't make it",
  "cant make it",
  "postpone",
  "reschedule",
  "not going to happen",
];
const COMPLETION_WORDS = [
  "done",
  "finished",
  "already booked",
  "already paid",
  "sent it",
  "sorted",
  "completed",
];

/** Very small date/number recognisers; enough to cite concrete details. */
const DATE_PATTERN =
  /\b(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|(?:mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|may|june|july|august|september|october|november|december|tomorrow|tonight|next week|next month)\b/gi;
const TIME_PATTERN =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]m)?\b|\b(?:[1-9]|1[0-2])\s?(?:am|pm)\b/gi;
const MONEY_PATTERN =
  /(?:[$£€₹]\s?\d+(?:[.,]\d{1,2})?|\b\d+(?:[.,]\d{2})?\s?(?:pounds?|dollars?|euros?|rupees?)\b)/gi;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptOf(body: string, max = 220): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function citationOf(message: AnalysisMessage): Citation {
  return {
    messageId: message.id,
    speakerLabel: message.senderLabel,
    participant: message.participant === "self" ? "self" : "contact",
    saidAt: message.sentAt,
    excerpt: excerptOf(message.body),
  };
}

function chronological(messages: readonly AnalysisMessage[]): AnalysisMessage[] {
  return [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
}

/** Text messages only: system rows and media placeholders carry no meaning. */
function meaningful(messages: readonly AnalysisMessage[]): AnalysisMessage[] {
  return chronological(messages).filter(
    (message) =>
      message.participant !== "system" && message.kind === "text" && message.body.trim().length > 0,
  );
}

export function extractTopics(messages: readonly AnalysisMessage[]): Topic[] {
  const text = meaningful(messages);
  const byLabel = new Map<string, Topic>();

  for (const message of text) {
    const lower = message.body.toLowerCase();

    for (const rule of TOPIC_RULES) {
      const hit = rule.keywords.some((keyword) =>
        new RegExp(`(^|\\W)${escapeRegex(keyword)}(\\W|$)`, "i").test(lower),
      );
      if (!hit) continue;

      const existing = byLabel.get(rule.label);
      if (existing) {
        existing.mentions += 1;
        existing.messageIds.push(message.id);
        existing.lastMentionedAt = message.sentAt;
      } else {
        byLabel.set(rule.label, {
          label: rule.label,
          mentions: 1,
          messageIds: [message.id],
          firstMentionedAt: message.sentAt,
          lastMentionedAt: message.sentAt,
          status: "inferred",
        });
      }
    }
  }

  return [...byLabel.values()].sort(
    (a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label),
  );
}

/**
 * Extracts plans.
 *
 * A proposal is a message containing plan language. Its status is then decided
 * by what happens afterwards: agreement, completion, or cancellation. When no
 * follow-up exists the plan stays `proposed` — the analyser never assumes it
 * went ahead.
 */
export function extractPlans(messages: readonly AnalysisMessage[]): Plan[] {
  const text = meaningful(messages);
  const plans: Plan[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const message = text[index] as AnalysisMessage;
    const lower = message.body.toLowerCase();

    const proposes = PLAN_KEYWORDS.some((keyword) =>
      new RegExp(`(^|\\W)${escapeRegex(keyword)}(\\W|$)`, "i").test(lower),
    );
    if (!proposes) continue;

    // Look at the next few messages for a reaction. Three is enough to catch
    // "shall we meet Saturday?" / "yes" / "I'll book the table".
    const followUps = text.slice(index + 1, index + 4);
    const followUpText = followUps.map((entry) => entry.body.toLowerCase());

    let status: Plan["status"] = "proposed";
    if (followUpText.some((entry) => COMPLETION_WORDS.some((word) => entry.includes(word)))) {
      status = "completed";
    } else if (
      followUpText.some((entry) => CANCELLATION_WORDS.some((word) => entry.includes(word)))
    ) {
      status = "cancelled";
    } else if (followUpText.some((entry) => AGREEMENT_WORDS.some((word) => entry.includes(word)))) {
      status = "agreed";
    }

    const dateMatch = message.body.match(DATE_PATTERN);
    const citations = [citationOf(message)];
    if (followUps.length > 0) citations.push(citationOf(followUps[0] as AnalysisMessage));

    plans.push({
      description: excerptOf(message.body),
      participant:
        message.participant === "self"
          ? "self"
          : message.participant === "contact"
            ? "contact"
            : "both",
      scheduledFor: dateMatch ? (dateMatch[0] as string) : null,
      status,
      citations,
      status_: "direct",
    });
  }

  // Collapse near-duplicate restatements of the same plan by description.
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = plan.description.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extracts questions and works out whether they were answered.
 *
 * "Answered" means the other participant sent a message after it. That is a
 * weak signal, so it is only ever reported as `appearsUnanswered` — never as
 * "ignored".
 */
export function extractQuestions(messages: readonly AnalysisMessage[]): Question[] {
  const text = meaningful(messages);
  const questions: Question[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const message = text[index] as AnalysisMessage;
    if (!message.body.includes("?")) continue;

    const askedBy = message.participant === "self" ? "self" : "contact";
    const reply = text
      .slice(index + 1, index + 4)
      .find((candidate) => candidate.participant !== message.participant);

    questions.push({
      text: excerptOf(message.body, 200),
      askedBy,
      messageId: message.id,
      askedAt: message.sentAt,
      // A follow-up from the same person does not count as an answer.
      appearsUnanswered: reply === undefined,
    });
  }

  return questions;
}

/**
 * Open threads: topics mentioned repeatedly whose most recent mention is a
 * question or a plan that never reached a resolution.
 */
export function extractOpenThreads(
  messages: readonly AnalysisMessage[],
  topics: readonly Topic[],
  plans: readonly Plan[],
  questions: readonly Question[],
): OpenThread[] {
  const text = meaningful(messages);
  const threads: OpenThread[] = [];

  for (const topic of topics) {
    if (topic.mentions < 2) continue;

    const topicMessages = text.filter((message) => topic.messageIds.includes(message.id));
    const lastMessage = topicMessages[topicMessages.length - 1];
    if (!lastMessage) continue;

    const unresolvedPlan = plans.find(
      (plan) =>
        (plan.status === "proposed" || plan.status === "agreed") &&
        plan.citations.some((citation) => topic.messageIds.includes(citation.messageId)),
    );

    const lastIsQuestion =
      questions.some((question) => question.messageId === lastMessage.id) &&
      !text
        .slice(text.indexOf(lastMessage) + 1)
        .some((entry) => entry.participant !== lastMessage.participant);

    if (!unresolvedPlan && !lastIsQuestion) continue;

    threads.push({
      topic: topic.label,
      reason: unresolvedPlan
        ? `A plan about ${topic.label} was raised and has not been confirmed as done.`
        : `The conversation about ${topic.label} ends with a question from ${
            lastMessage.participant === "self" ? "you" : "the contact"
          }.`,
      citations: unresolvedPlan ? unresolvedPlan.citations : [citationOf(lastMessage)],
      lastActivityAt: topic.lastMentionedAt,
      status_: "inferred",
    });
  }

  return threads.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

/** Concrete details (dates, times, money) with the message that states them. */
export function extractDetails(
  messages: readonly AnalysisMessage[],
): ConversationUnderstanding["details"] {
  const details: ConversationUnderstanding["details"] = [];
  const seen = new Set<string>();

  for (const message of meaningful(messages)) {
    const add = (kind: "date" | "time" | "money", value: string) => {
      const key = `${kind}:${value.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      details.push({ kind, value, citation: citationOf(message) });
    };

    for (const match of message.body.match(DATE_PATTERN) ?? []) add("date", match);
    for (const match of message.body.match(TIME_PATTERN) ?? []) add("time", match);
    for (const match of message.body.match(MONEY_PATTERN) ?? []) add("money", match);
  }

  return details.slice(0, 40);
}

export function understandConversation(
  messages: readonly AnalysisMessage[],
): ConversationUnderstanding {
  const text = meaningful(messages);
  const topics = extractTopics(messages);
  const plans = extractPlans(messages);
  const questions = extractQuestions(messages);
  const openThreads = extractOpenThreads(messages, topics, plans, questions);

  return {
    topics,
    plans,
    questions,
    openThreads,
    details: extractDetails(messages),
    messageCount: text.length,
  };
}
