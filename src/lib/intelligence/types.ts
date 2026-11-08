/**
 * Shared types for the intelligence engine.
 *
 * These are the *inputs* to analysis: a normalised, already-attributed view of
 * the conversation. Keeping them free of Supabase row shapes means every
 * analysis service is a pure function that can be tested without a database.
 */

/** A message as the analyser sees it. */
export type AnalysisMessage = {
  id: string;
  /** Who produced this message, decided by the confirmed sender mapping. */
  participant: "self" | "contact" | "system";
  /** Original sender label from the export, preserved for attribution. */
  senderLabel: string | null;
  sentAt: string; // ISO 8601
  body: string;
  kind: "text" | "media" | "missed_call" | "deleted" | "system";
};

export type ConversationInput = {
  /** The contact's display name, used only for prose, never for attribution. */
  contactName: string;
  /** The user's own display name, when known. */
  selfName: string | null;
  messages: AnalysisMessage[];
};

/**
 * How much evidence an analysis had.
 *
 * Reported alongside every result so the UI can say "low confidence" instead of
 * presenting a guess as a finding.
 */
export type EvidenceCoverage = {
  /** Messages actually used (text messages from the analysed participants). */
  sampleSize: number;
  /** Messages available in the window. */
  availableMessages: number;
  /** Minimum sample this analyser considers usable. */
  minimumSample: number;
  level: "insufficient" | "low" | "moderate" | "strong";
  /** Human-readable explanation when confidence is reduced. */
  note: string | null;
};

/** Minimum sample sizes, defined once so tests and UI agree. */
export const SAMPLE_THRESHOLDS = {
  /** Below this, no style profile is produced at all. */
  insufficient: 8,
  /** Below this, a profile is produced but flagged low confidence. */
  low: 25,
  /** Below this, confidence is "moderate". */
  moderate: 60,
} as const;

export function assessCoverage(
  sampleSize: number,
  availableMessages: number,
  minimumSample: number = SAMPLE_THRESHOLDS.insufficient,
): EvidenceCoverage {
  let level: EvidenceCoverage["level"];
  let note: string | null = null;

  if (sampleSize < minimumSample) {
    level = "insufficient";
    note =
      `Only ${sampleSize} usable message${sampleSize === 1 ? "" : "s"} ` +
      `(need at least ${minimumSample}). Treat anything shown here as a guess.`;
  } else if (sampleSize < SAMPLE_THRESHOLDS.low) {
    level = "low";
    note = `Based on ${sampleSize} messages, which is a small sample. Patterns may not hold.`;
  } else if (sampleSize < SAMPLE_THRESHOLDS.moderate) {
    level = "moderate";
  } else {
    level = "strong";
  }

  return { sampleSize, availableMessages, minimumSample, level, note };
}

/** Maps a coverage level to the numeric confidence stored in the database. */
export function coverageToConfidence(coverage: EvidenceCoverage): number {
  switch (coverage.level) {
    case "insufficient":
      return 0.15;
    case "low":
      return 0.4;
    case "moderate":
      return 0.65;
    case "strong":
      return 0.85;
  }
}
