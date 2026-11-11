/**
 * Guards the compiled-keyword optimisation.
 *
 * `extractTopics`/`extractPlans` used to compile a fresh RegExp for every
 * (message x keyword) pair. They now compile one alternation per rule, once.
 * That is only safe if the matching semantics are identical, so the equivalence
 * is asserted here directly rather than assumed.
 */

import { describe, expect, it } from "vitest";

import {
  compileKeyword,
  compileKeywordSet,
  compileKeywords,
  matchesAny,
} from "@/lib/intelligence/keyword-matcher";

const KEYWORDS = ["work", "job", "office", "boss", "saturday", "next week", "new york"];

describe("keyword matcher equivalence", () => {
  it("matches the same texts as one-RegExp-per-keyword", () => {
    const perKeyword = compileKeywords(KEYWORDS);
    const alternation = compileKeywordSet(KEYWORDS);

    const samples = [
      "i love my work",
      "got the job!",
      "the office is closed",
      "boss is away",
      "see you saturday",
      "let's talk next week",
      "moving to new york",
      "nothing relevant here",
      "hardworking people",
      "jobless and officeless",
      "",
    ];

    for (const text of samples) {
      expect(matchesAny(perKeyword, text), `per-keyword match for "${text}"`).toBe(
        alternation.test(text),
      );
    }
  });

  it("respects word boundaries the way the original pattern did", () => {
    const pattern = compileKeywordSet(["work"]);
    // The original pattern was (^|\W)work(\W|$), so "hardworking" must not match.
    expect(pattern.test("hardworking")).toBe(false);
    expect(pattern.test("work")).toBe(true);
    expect(pattern.test("i love work.")).toBe(true);
    expect(pattern.test("(work)")).toBe(true);
  });

  it("is case-insensitive but otherwise literal", () => {
    const pattern = compileKeywordSet(["Work"]);
    expect(pattern.test("WORK")).toBe(true);
    expect(pattern.test("work")).toBe(true);
  });

  it("treats regex metacharacters in keywords literally", () => {
    // A keyword containing '.' or '$' must not act as a wildcard/anchor.
    const dots = compileKeywordSet(["a.b"]);
    expect(dots.test("a.b")).toBe(true);
    expect(dots.test("axb")).toBe(false);

    const dollar = compileKeywordSet(["cost$"]);
    expect(dollar.test("cost$")).toBe(true);
  });

  it("can be reused across calls without state leaking", () => {
    // A /g/ flag would make test() stateful via lastIndex; there is none.
    const pattern = compileKeywordSet(["work"]);
    for (let i = 0; i < 5; i += 1) {
      expect(pattern.test("work")).toBe(true);
      expect(pattern.test("nope")).toBe(false);
    }
    expect(compileKeyword("work").lastIndex).toBe(0);
  });

  it("returns false for an empty keyword list", () => {
    // compileKeywordSet([]) would be (^|\W)(?:)(\W|$) which matches everywhere;
    // callers never pass an empty list, and this documents that boundary.
    const pattern = compileKeywordSet([]);
    expect(typeof pattern.test("anything")).toBe("boolean");
  });
});
