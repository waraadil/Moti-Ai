/**
 * Rule-based memory extraction.
 *
 * Used by the deterministic provider and as a cross-check on model output. Each
 * rule needs a *self-describing statement* in the text ("I'm training for a
 * marathon", "my sister lives in Lisbon") plus a citable message. Speculation,
 * hypotheticals and third-party hearsay are filtered out.
 */

import type { AnalysisMessage } from "./types";
import type { MemoryCandidate } from "./schemas";

type Rule = {
  category: MemoryCandidate["category"];
  /** Patterns are applied to a single message body. */
  patterns: RegExp[];
  /** Which side of the conversation the fact describes. */
  about: (message: AnalysisMessage) => MemoryCandidate["about"];
  isSensitive?: boolean;
  /** Confidence ceiling for this rule. */
  confidence: number;
};

/**
 * First-person present-tense statements about stable facts.
 * Deliberately narrow: broad patterns produce plausible-sounding nonsense.
 */
const RULES: Rule[] = [
  {
    category: "goal",
    patterns: [
      /\b(?:i'?m|i am|im) (?:training|preparing|working) (?:for|towards|toward) (?:an?|the) ([^.!?]{3,60})/i,
      /\b(?:i'?m|i am|im) (?:trying|planning) to ([^.!?]{3,60})/i,
      /\bmy (?:goal|aim|plan) is (?:to )?([^.!?]{3,60})/i,
      /\bi want to ([^.!?]{3,60})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    confidence: 0.7,
  },
  {
    category: "preference",
    patterns: [
      /\bi (?:really )?(?:love|like|enjoy|prefer) ([^.!?]{2,60})/i,
      /\bi (?:hate|dislike|can'?t stand) ([^.!?]{2,60})/i,
      /\bi'?m (?:not )?(?:a big fan of|into) ([^.!?]{2,60})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    confidence: 0.65,
  },
  {
    category: "routine",
    patterns: [
      /\bi (?:usually|always|normally|every (?:day|morning|week|weekend)) ([^.!?]{3,60})/i,
      /\bi (?:go|get up|wake up) (?:to|at) ([^.!?]{3,60})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    confidence: 0.6,
  },
  {
    category: "boundary",
    patterns: [
      // Only first-person boundary talk. A bare imperative ("don't be late")
      // is advice to the other person, not a fact about this one.
      /\bi'?d rather (?:you )?(?:not )?([^.!?]{3,60})/i,
      /\bi (?:need|want) (?:some )?(space|time alone|quiet)\b([^.!?]{0,40})/i,
      /\bi'?m not comfortable (?:with )?([^.!?]{3,60})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    confidence: 0.6,
  },
  {
    category: "life_event",
    patterns: [
      /\bmy (?:sister|brother|mum|mom|dad|mother|father|partner|wife|husband|son|daughter|friend) ([^.!?]{3,70})/i,
      /\bi (?:just )?(?:moved|started|finished|graduated|got|bought|adopted) ([^.!?]{3,70})/i,
      /\bi(?:'ve| have) been ([^.!?]{3,70})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    confidence: 0.6,
  },
  {
    category: "sensitive",
    patterns: [
      /\b(?:i'?m|i am|im) (?:going through|struggling with|dealing with) ([^.!?]{3,70})/i,
      /\bmy (?:anxiety|depression|diagnosis|treatment|illness) ([^.!?]{0,60})/i,
    ],
    about: (message) => (message.participant === "self" ? "self" : "contact"),
    isSensitive: true,
    confidence: 0.55,
  },
];

/** Signals that a sentence is hypothetical, negated or hearsay. */
const UNSUITABLE = [
  /\bif i\b/i,
  /\bi (?:would|'d|could)\b/i,
  /\bi (?:never|don'?t|didn'?t) (?:really )?(?:used to)\b/i,
  /\b(?:apparently|supposedly|someone said|he said|she said|they said)\b/i,
  /\b(?:not sure|maybe|might|perhaps|probably)\b/i,
  /\?/, // questions are not statements of fact
];

function isSuitable(body: string): boolean {
  return !UNSUITABLE.some((pattern) => pattern.test(body));
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[,;]+$/, "")
    .trim()
    .slice(0, 120);
}

export type MemoryRuleResult = {
  candidates: MemoryCandidate[];
  /** Statements that looked promising but were rejected, with the reason. */
  rejected: Array<{ excerpt: string; reason: string }>;
};

export function extractMemoriesByRule(
  messages: readonly AnalysisMessage[],
  options: { selfName: string | null; contactName: string },
): MemoryRuleResult {
  const candidates: MemoryCandidate[] = [];
  const rejected: MemoryRuleResult["rejected"] = [];
  const seen = new Map<string, string>(); // statement key -> message id

  for (const message of messages) {
    if (message.participant === "system" || message.kind !== "text") continue;
    const body = message.body.trim();
    if (body.length < 8) continue;

    if (!isSuitable(body)) {
      // Only record rejections that a rule would otherwise have matched, so the
      // "rejected" list stays meaningful.
      if (RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(body)))) {
        rejected.push({
          excerpt: body.slice(0, 140),
          reason: "Hypothetical, negated or uncertain wording — not stored as a fact.",
        });
      }
      continue;
    }

    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        const match = pattern.exec(body);
        if (!match) continue;

        const subject =
          message.participant === "self" ? (options.selfName ?? "You") : options.contactName;

        const object = stripLeadingTo(cleanFragment(tidy(match[1] ?? "")));
        if (!isUsableFragment(object)) continue;

        const statement = `${subject} ${PHRASING[rule.category](object)}`;

        const key = statement.toLowerCase();
        const existing = seen.get(key);
        if (existing) {
          // Same fact stated twice: attach the extra evidence instead of
          // creating a duplicate memory.
          const prior = candidates.find(
            (candidate) => candidate.evidenceMessageIds[0] === existing,
          );
          if (prior && !prior.evidenceMessageIds.includes(message.id)) {
            prior.evidenceMessageIds = [...prior.evidenceMessageIds, message.id].slice(0, 5);
          }
          break;
        }

        seen.set(key, message.id);
        candidates.push({
          statement,
          category: rule.category,
          about: rule.about(message),
          details: `From: "${body.slice(0, 180)}"`,
          topics: [],
          evidenceStatus: "direct",
          confidence: rule.confidence,
          isSensitive: rule.isSensitive ?? false,
          evidenceMessageIds: [message.id],
        });
        break;
      }
    }
  }

  return { candidates, rejected };
}

/**
 * Rewrites a first-person fragment into a third-person statement.
 *
 * Naive templating produced nonsense like "Priya has asked about do too much
 * at once", so each rule states exactly how its captured fragment is phrased.
 */
const PHRASING: Record<MemoryCandidate["category"], (object: string) => string> = {
  goal: (object) => `is working towards: ${object}`,
  preference: (object) => `has a preference: ${object}`,
  routine: (object) => `has a routine: ${object}`,
  boundary: (object) => `has a boundary: ${object}`,
  sensitive: (object) => `has shared something sensitive: ${object}`,
  life_event: (object) => `mentioned a life event: ${object}`,
  relationship: (object) => `mentioned a relationship detail: ${object}`,
};

/** Filler that trails a spoken sentence and adds nothing to the fact. */
const TRAILING_FILLER = /\s+(?:tbh|lol|haha|tho|though|anyway|by the way|actually|honestly)\s*$/i;

/**
 * Truncates a captured fragment at the first clause boundary so a memory never
 * reads as a half sentence ("big send-offs so I'm skipping the party").
 */
function cleanFragment(value: string): string {
  let result = value
    .replace(/\s+(?:by the way|so that|because|since|and then)\b.*$/i, "")
    .replace(/\s+so\b.*$/i, "")
    .replace(/\s*,.*$/, "");
  // Strip filler repeatedly: "running too tbh" -> "running too".
  let previous: string;
  do {
    previous = result;
    result = result.replace(TRAILING_FILLER, "");
  } while (result !== previous);
  return result.trim();
}

/** Drops a leading infinitive so "to start running" reads as "start running". */
function stripLeadingTo(value: string): string {
  return value.replace(/^to\s+/i, "").trim();
}

/**
 * Rejects fragments that are not a self-contained fact. These are the near
 * misses that make generated memories look plausible but wrong.
 */
function isUsableFragment(fragment: string): boolean {
  const value = fragment.trim();
  if (value.length < 3) return false;
  // Starts mid-clause: a relative pronoun with no antecedent.
  if (/^(?:it|that|this|they|them|there|which|who)\b/i.test(value)) return false;
  // A bare verb with no object ("about do too much at once").
  if (/^(?:do|did|be|is|are|was|were)\b/i.test(value)) return false;
  // More than one clause: the capture spilled across a comma.
  if ((value.match(/,\s/g) ?? []).length > 1) return false;
  return true;
}
