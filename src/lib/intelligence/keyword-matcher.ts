/**
 * Compiled keyword matchers.
 *
 * Why this module exists
 * ----------------------
 * `extractTopics` and `extractPlans` used to build a fresh `RegExp` for every
 * (message x keyword) pair:
 *
 *     rule.keywords.some((kw) =>
 *       new RegExp(`(^|\\W)${escapeRegex(kw)}(\\W|$)`, "i").test(lower))
 *
 * That compiles the same pattern thousands of times for the same result. On a
 * 50,000-message export with 11 topic rules it is millions of redundant
 * compilations, and it dominated the understanding benchmark.
 *
 * The patterns are constant for the lifetime of the process, so they are
 * compiled once here and reused. Behaviour is byte-for-byte identical: same
 * source string, same `i` flag, same `test()` semantics. `test()` on a
 * non-global regex has no `lastIndex` state, so sharing one instance across
 * calls is safe.
 */

/** Escapes a literal keyword so it can be embedded in a RegExp source. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the word-boundary matcher for a keyword, exactly as the original
 * inline call did: `(^|\W)keyword(\W|$)` with the `i` flag.
 */
export function compileKeyword(keyword: string): RegExp {
  return new RegExp(`(^|\\W)${escapeRegex(keyword)}(\\W|$)`, "i");
}

/** Compiles a list of keywords once, preserving order. */
export function compileKeywords(keywords: readonly string[]): readonly RegExp[] {
  return keywords.map(compileKeyword);
}

/**
 * True when any of the pre-compiled patterns matches the (already lowercased)
 * text. Mirrors `keywords.some((kw) => pattern.test(text))`.
 */
export function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Compiles a whole keyword list into ONE alternation pattern:
 * `(^|\W)(kw1|kw2|kw3)(\W|$)`.
 *
 * For a boolean "does this text mention any of these keywords" question this is
 * equivalent to testing each keyword separately, but it is a single `test()`
 * call instead of N. Used by the hot loops in understanding.ts.
 */
export function compileKeywordSet(keywords: readonly string[]): RegExp {
  const alternation = keywords.map(escapeRegex).join("|");
  return new RegExp(`(^|\\W)(?:${alternation})(\\W|$)`, "i");
}
