/**
 * A neutral `StyleMetrics` value for tests that need a context but do not care
 * about style numbers.
 *
 * Built from the real shape so a field added to `StyleMetrics` breaks here
 * instead of silently producing an unrealistic fixture.
 */

import type { StyleMetrics } from "@/lib/intelligence/style";

export function styleFromFixture(
  overrides: Partial<StyleMetrics> = {},
): StyleMetrics {
  return {
    participant: "self",
    messageCount: 50,
    averageChars: 40,
    medianChars: 32,
    longestChars: 120,
    shortMessageRatio: 0.3,
    questionRatio: 0.15,
    exclamationRate: 0.1,
    emojiRatio: 0.2,
    lowercaseRatio: 0.55,
    noTerminalPunctuationRatio: 0.6,
    vocabularyDiversity: 0.42,
    topWords: [{ word: "yaar", count: 7 }],
    abbreviations: ["tmrw", "hmm"],
    medianReplyMinutes: 6,
    fastReplyCount: 12,
    topEmoji: [{ emoji: "😂", count: 4 }],
    coverage: {
      sampleSize: 50,
      availableMessages: 60,
      minimumSample: 20,
      level: "moderate",
      note: null,
    },
    confidence: 0.62,
    isInsufficient: false,
    ...overrides,
  };
}
