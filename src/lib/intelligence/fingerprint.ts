/**
 * Memory fingerprinting.
 *
 * A memory's fingerprint is a hash of its normalised statement. Migration 0008
 * makes it unique per contact for *active* rows, which is what stops a re-run of
 * analysis from storing the same fact twice.
 *
 * It lives here — pure, no database, no `server-only` — because the pipeline,
 * the memory repository and the tests must all derive it identically. Two
 * slightly different normalisations would silently defeat the unique index.
 */

import { createHash } from "node:crypto";

/**
 * Normalises a statement so wording variants collapse: case, punctuation and
 * whitespace are all ignored.
 *
 * Deliberately does NOT stem, reorder or drop words. "Priya likes coffee" and
 * "Priya dislikes coffee" must fingerprint differently; over-eager normalisation
 * would merge a fact with its opposite.
 */
export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 of the normalised statement, lowercase hex. */
export function memoryFingerprint(statement: string): string {
  return createHash("sha256").update(normalizeStatement(statement)).digest("hex");
}
