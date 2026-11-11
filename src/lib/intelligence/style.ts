/**
 * Communication style analysis.
 *
 * Every number produced here is computed from the messages — nothing is
 * generated or estimated. That makes the output reproducible, testable, and
 * honest: when the sample is too small we say so instead of inventing a profile.
 *
 * The user and the contact are analysed by the same code over their own
 * messages, so the two profiles are directly comparable.
 */

import {
  SAMPLE_THRESHOLDS,
  assessCoverage,
  coverageToConfidence,
  type AnalysisMessage,
  type EvidenceCoverage,
} from "./types";

export type StyleMetrics = {
  participant: "self" | "contact";
  messageCount: number;
  /** Mean characters per message, rounded. */
  averageChars: number;
  medianChars: number;
  /** Longest message, in characters. */
  longestChars: number;
  /** Share of messages that are 1-2 words. */
  shortMessageRatio: number;
  /** Share of messages ending with a question mark or containing a question. */
  questionRatio: number;
  /** Exclamation marks per message. */
  exclamationRate: number;
  /** Share of messages containing at least one emoji. */
  emojiRatio: number;
  /** Share of messages written in all lower case. */
  lowercaseRatio: number;
  /** Share of messages ending without terminal punctuation. */
  noTerminalPunctuationRatio: number;
  /** Distinct tokens divided by total tokens. */
  vocabularyDiversity: number;
  /** Most frequent meaningful words, excluding stopwords. */
  topWords: Array<{ word: string; count: number }>;
  /** Common contractions/abbreviations observed. */
  abbreviations: string[];
  /** Median minutes to reply to the other participant. */
  medianReplyMinutes: number | null;
  /** Number of replies within 5 minutes. */
  fastReplyCount: number;
  /** Emoji characters observed, most frequent first. */
  topEmoji: Array<{ emoji: string; count: number }>;
  coverage: EvidenceCoverage;
  /** Numeric confidence derived from coverage, 0..1. */
  confidence: number;
  /** True when there is not enough data to describe this participant. */
  isInsufficient: boolean;
};

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "don",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "more",
  "most",
  "my",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "ok",
  "okay",
  "yeah",
  "yes",
  "oh",
  "hi",
  "hey",
  "lol",
  "haha",
  "mmm",
  "im",
  "ive",
  "dont",
  "didnt",
  "cant",
  "wont",
  "thats",
  "its",
  "youre",
  "gonna",
  "wanna",
  "gotta",
  "also",
]);

/** Matches emoji sequences including skin tones, ZWJ joins and flags. */
const EMOJI_PATTERN =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)|(?:\p{Regional_Indicator}{2})/gu;

/** Abbreviations/contractions that signal informal register. */
const ABBREVIATIONS = [
  "tbh",
  "imo",
  "imho",
  "idk",
  "nvm",
  "btw",
  "fyi",
  "asap",
  "omg",
  "lol",
  "lmao",
  "brb",
  "rn",
  "afaik",
  "wdyt",
  "smh",
  "fomo",
  "ttyl",
  "ily",
  "ngl",
  "dm",
  "irl",
  "lol",
  "hbu",
  "wfh",
  "eta",
  "rsvp",
  "bday",
  "gonna",
  "wanna",
  "gotta",
  "kinda",
  "sorta",
  "dunno",
  "cuz",
  "coz",
  "thx",
  "pls",
  "plz",
];

const TERMINAL_PUNCTUATION = /[.!?…]$/;

function tokenize(body: string): string[] {
  return body
    .toLowerCase()
    .replace(EMOJI_PATTERN, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^'+|'+$/g, ""))
    .filter((token) => token.length > 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number);
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Computes reply latency: for each message from `participant`, the gap from the
 * immediately preceding message by the other side.
 *
 * Gaps over 7 days are excluded — they are usually a new conversation rather
 * than a slow reply, and would distort the median.
 */
const MAX_REPLY_GAP_MINUTES = 7 * 24 * 60;

export function computeReplyDelays(
  messages: readonly AnalysisMessage[],
  participant: "self" | "contact",
): number[] {
  const chronological = [...messages]
    .filter((message) => message.participant !== "system" && message.kind === "text")
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));

  const delays: number[] = [];

  for (let index = 1; index < chronological.length; index += 1) {
    const current = chronological[index] as AnalysisMessage;
    const previous = chronological[index - 1] as AnalysisMessage;

    if (current.participant !== participant) continue;
    if (previous.participant === participant) continue;
    if (previous.participant === "system") continue;

    const gapMinutes = (Date.parse(current.sentAt) - Date.parse(previous.sentAt)) / 60_000;
    if (!Number.isFinite(gapMinutes) || gapMinutes < 0) continue;
    if (gapMinutes > MAX_REPLY_GAP_MINUTES) continue;

    delays.push(gapMinutes);
  }

  return delays;
}

/** Analyses one participant's messages. Never mixes the two sides. */
export function analyseStyle(
  messages: readonly AnalysisMessage[],
  participant: "self" | "contact",
): StyleMetrics {
  // Only this participant's text messages; anything else would contaminate the
  // profile with the other person's habits.
  const own = messages.filter(
    (message) =>
      message.participant === participant &&
      message.kind === "text" &&
      message.body.trim().length > 0,
  );

  const messageCount = own.length;
  const bodies = own.map((message) => message.body.trim());
  const lengths = bodies.map((body) => body.length);
  const coverage = assessCoverage(messageCount, messages.length);

  if (messageCount === 0) {
    return {
      participant,
      messageCount: 0,
      averageChars: 0,
      medianChars: 0,
      longestChars: 0,
      shortMessageRatio: 0,
      questionRatio: 0,
      exclamationRate: 0,
      emojiRatio: 0,
      lowercaseRatio: 0,
      noTerminalPunctuationRatio: 0,
      vocabularyDiversity: 0,
      topWords: [],
      abbreviations: [],
      medianReplyMinutes: null,
      fastReplyCount: 0,
      topEmoji: [],
      coverage,
      confidence: 0,
      isInsufficient: true,
    };
  }

  // --- Per-message features ---------------------------------------------
  let shortMessages = 0;
  let questions = 0;
  let exclamations = 0;
  let withEmoji = 0;
  let lowercase = 0;
  let noTerminal = 0;

  const emojiCounts = new Map<string, number>();

  for (const body of bodies) {
    const words = tokenize(body);
    if (words.length <= 2) shortMessages += 1;
    if (body.includes("?")) questions += 1;
    exclamations += (body.match(/!/g) ?? []).length;
    if (!TERMINAL_PUNCTUATION.test(body)) noTerminal += 1;

    const emoji = body.match(EMOJI_PATTERN);
    if (emoji) {
      withEmoji += 1;
      for (const glyph of emoji) {
        emojiCounts.set(glyph, (emojiCounts.get(glyph) ?? 0) + 1);
      }
    }

    // "All lower case" ignores digits/punctuation so "ok!" still counts.
    const letters = body.replace(/[^\p{L}]/gu, "");
    if (letters.length > 0 && letters === letters.toLowerCase()) lowercase += 1;
  }

  // --- Vocabulary --------------------------------------------------------
  const wordCounts = new Map<string, number>();
  let totalTokens = 0;

  for (const body of bodies) {
    for (const token of tokenize(body)) {
      totalTokens += 1;
      if (STOPWORDS.has(token) || token.length < 3) continue;
      wordCounts.set(token, (wordCounts.get(token) ?? 0) + 1);
    }
  }

  const topWords = [...wordCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([word, count]) => ({ word, count }));

  const abbreviations = ABBREVIATIONS.filter((abbreviation) => {
    const pattern = new RegExp(`(^|\\W)${abbreviation}(\\W|$)`, "i");
    return bodies.some((body) => pattern.test(body));
  });

  const delays = computeReplyDelays(messages, participant);
  const fastReplyCount = delays.filter((delay) => delay <= 5).length;

  return {
    participant,
    messageCount,
    averageChars: Math.round(lengths.reduce((sum, length) => sum + length, 0) / messageCount),
    medianChars: median(lengths),
    longestChars: Math.max(...lengths),
    shortMessageRatio: round(shortMessages / messageCount),
    questionRatio: round(questions / messageCount),
    exclamationRate: round(exclamations / messageCount),
    emojiRatio: round(withEmoji / messageCount),
    lowercaseRatio: round(lowercase / messageCount),
    noTerminalPunctuationRatio: round(noTerminal / messageCount),
    vocabularyDiversity: totalTokens === 0 ? 0 : round(wordCounts.size / totalTokens),
    topWords,
    abbreviations,
    medianReplyMinutes: delays.length === 0 ? null : Math.round(median(delays)),
    fastReplyCount,
    topEmoji: [...emojiCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([emoji, count]) => ({ emoji, count })),
    coverage,
    confidence: coverageToConfidence(coverage),
    isInsufficient: coverage.level === "insufficient",
  };
}

/** The pair of profiles for a conversation, analysed independently. */
export type StyleAnalysisResult = {
  self: StyleMetrics;
  contact: StyleMetrics;
  /** True when both sides have usable evidence. */
  isReliable: boolean;
};

export function analyseConversationStyle(
  messages: readonly AnalysisMessage[],
): StyleAnalysisResult {
  const self = analyseStyle(messages, "self");
  const contact = analyseStyle(messages, "contact");

  return {
    self,
    contact,
    isReliable: self.coverage.level !== "insufficient" && contact.coverage.level !== "insufficient",
  };
}

/**
 * Turns metrics into an observational summary.
 *
 * Deliberately descriptive ("writes in short bursts") rather than character-
 * ising ("is a brief person"): the data supports the former, not the latter.
 */
export function describeStyle(metrics: StyleMetrics, displayName: string): string {
  if (metrics.messageCount === 0) {
    return `No messages from ${displayName} were found, so no style profile could be built.`;
  }

  if (metrics.isInsufficient) {
    return (
      `${displayName} has only ${metrics.messageCount} usable messages, below the ` +
      `${SAMPLE_THRESHOLDS.insufficient} needed for a dependable profile. ` +
      "Any pattern here is indicative only."
    );
  }

  const traits: string[] = [];

  if (metrics.medianChars <= 20) traits.push("short, message-per-thought replies");
  else if (metrics.medianChars >= 120) traits.push("long, composed messages");
  else traits.push("mid-length messages");

  if (metrics.shortMessageRatio >= 0.4) traits.push("many one or two word replies");
  if (metrics.questionRatio >= 0.25) traits.push("asks a lot of questions");
  if (metrics.exclamationRate >= 0.4) traits.push("uses exclamation marks frequently");
  if (metrics.emojiRatio >= 0.3) traits.push("uses emoji often");
  else if (metrics.emojiRatio === 0) traits.push("never uses emoji");
  if (metrics.lowercaseRatio >= 0.6) traits.push("writes all in lower case");
  if (metrics.noTerminalPunctuationRatio >= 0.6) traits.push("skips end-of-sentence punctuation");
  if (metrics.abbreviations.length >= 3) {
    traits.push(`uses abbreviations such as ${metrics.abbreviations.slice(0, 3).join(", ")}`);
  }

  const pace =
    metrics.medianReplyMinutes === null
      ? "reply pace cannot be measured from this sample"
      : metrics.medianReplyMinutes <= 10
        ? `typically replies within about ${metrics.medianReplyMinutes} minutes`
        : metrics.medianReplyMinutes <= 180
          ? `typically replies within about ${Math.round(metrics.medianReplyMinutes / 60)} hour(s)`
          : "often takes a long time to reply";

  return (
    `${displayName} (${metrics.messageCount} messages): ${traits.join(", ")}; ${pace}. ` +
    `Confidence: ${metrics.coverage.level}.`
  );
}
