/**
 * WhatsApp export parser.
 *
 * Pure functions only: no I/O, no database, no network. That keeps the trickiest
 * logic in the product (turning a messy text export into attributable messages)
 * unit-testable and independent of Supabase.
 *
 * Supported shapes:
 *   Android (most locales):  01/01/2023, 09:41 - Alice: hello
 *                            31.12.2023, 23:59 - Alice: <Media omitted>
 *   Android (bracketed):     [01/01/2023, 09:41:23] Alice: hello
 *   iOS:                     [01/01/2023, 09:41:23] Alice: hello
 *
 * Anything that cannot be read confidently is skipped and reported as a warning
 * rather than guessed at, because a wrong attribution corrupts every downstream
 * analysis.
 */

export type ParseWarningCode =
  "unparsed_line" | "ambiguous_date" | "missing_sender" | "invalid_timestamp" | "truncated_message";

export type ParseWarning = {
  code: ParseWarningCode;
  line: number;
  message: string;
  excerpt?: string;
};

export type ParsedMessageKind = "text" | "media" | "missed_call" | "deleted" | "system";

export type ParsedMessage = {
  /** 1-based line number of the first line of the message. */
  lineNumber: number;
  /** Sender label exactly as it appears in the export. Null for system rows. */
  senderLabel: string | null;
  /** Null when the export format does not include a parseable timestamp. */
  sentAt: Date | null;
  kind: ParsedMessageKind;
  body: string | null;
  mediaFilename: string | null;
  isForwarded: boolean;
  rawLine: string;
};

export type ParseResult = {
  messages: ParsedMessage[];
  warnings: ParseWarning[];
  totalLines: number;
  skippedLines: number;
  /** Sender labels in order of first appearance. */
  detectedParticipants: string[];
};

export type ParseOptions = {
  /**
   * WhatsApp writes dates in the phone's locale order. "DMY" (default) parses
   * 01/02/2023 as 1 February; "MDY" parses it as 2 January.
   */
  dateOrder?: "DMY" | "MDY";
  /** Upper bound on messages per file, to protect against runaway inputs. */
  maxMessages?: number;
};

const DEFAULT_MAX_MESSAGES = 200_000;

// WhatsApp inserts U+200E / U+200F direction marks and zero-width spaces around
// timestamps and media placeholders. Strip them before matching.
const INVISIBLES = /[\u200b\u200c\u200d\u200e\u200f\ufeff]/g;

function stripInvisibles(value: string): string {
  return value.replace(INVISIBLES, "");
}

/**
 * Header patterns. Each captures: date, time, optional bracketed form and the
 * remainder ("Sender: text" or a system line).
 *
 * Written as separate patterns rather than one mega-regex so that failures are
 * attributable to a specific export shape when a user reports a problem.
 */
type HeaderMatch = {
  datePart: string;
  timePart: string;
  remainder: string;
};

const HEADER_PATTERNS: RegExp[] = [
  // [01/01/2023, 09:41:23] Sender: text
  /^\[(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]\s?(.*)$/,
  // 01/01/2023, 09:41 - Sender: text   (also . and - separators)
  /^(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\s+[-–]\s?(.*)$/,
];

function matchHeader(line: string): HeaderMatch | null {
  for (const pattern of HEADER_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const [, datePart, timePart, remainder] = match;
    if (!datePart || !timePart || remainder === undefined) continue;
    return { datePart, timePart, remainder };
  }
  return null;
}

/**
 * Parses a WhatsApp date/time pair into a Date.
 * Returns null when the value is not a real calendar date (e.g. 31/02/2023).
 */
export function parseTimestamp(
  datePart: string,
  timePart: string,
  dateOrder: "DMY" | "MDY" = "DMY",
): Date | null {
  const dateChunks = datePart.split(/[/.-]/).map((chunk) => Number.parseInt(chunk, 10));
  if (dateChunks.length !== 3 || dateChunks.some((chunk) => Number.isNaN(chunk))) return null;

  const [first, second, third] = dateChunks as [number, number, number];

  let year: number;
  let month: number;
  let day: number;

  if (first > 31) {
    // YYYY-MM-DD (ISO-ish exports)
    year = first;
    month = second;
    day = third;
  } else {
    // 2-digit years appear in older exports. WhatsApp exports are recent enough
    // that 00-69 => 2000s, 70-99 => 1900s follows the usual convention.
    year = third < 100 ? (third < 70 ? 2000 + third : 1900 + third) : third;
    if (dateOrder === "DMY") {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(timePart.trim());
  if (!timeMatch) return null;

  let hours = Number.parseInt(timeMatch[1] ?? "0", 10);
  const minutes = Number.parseInt(timeMatch[2] ?? "0", 10);
  const seconds = Number.parseInt(timeMatch[3] ?? "0", 10);
  const meridiem = timeMatch[4]?.toLowerCase();

  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const candidate = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));

  // Rejects impossible dates such as 31 February, which Date would roll over.
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return candidate;
}

const MEDIA_PLACEHOLDER =
  /^(?:<Media omitted>|(?:image|video|audio|document|sticker|GIF|Contact card) omitted)$/i;

const MEDIA_ATTACHED =
  /^(?<filename>[^:\n]{1,180}?\.(?:jpe?g|png|mp4|opus|mp3|ogg|pdf|webp|vcf|3gp|aac))\s*\(file attached\)$/i;

const DELETED_MARKERS = [
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^you deleted this message and /i,
];

const MISSED_CALL = /^(?:missed (?:voice|video) call|missed call)$/i;

// System rows have no "Sender:" prefix. Keep the list narrow so a genuine
// message with a colon is never mistaken for a system notice.
const SYSTEM_PREFIXES = [
  /^messages and calls are end-to-end encrypted/i,
  /^you (?:created|changed|joined|added|left|removed)/i,
  /changed the subject to/i,
  /changed this group's icon/i,
  /^.+ added you$/i,
  /^.+ joined using this group's invite link/i,
  /^.+ changed their phone number/i,
  /^.+ pinned a message/i,
];

const FORWARDED_PREFIX = /^forwarded$/i;

type ClassifiedBody = {
  kind: ParsedMessageKind;
  body: string | null;
  mediaFilename: string | null;
  isForwarded: boolean;
};

/**
 * Classifies the text of one message and extracts media metadata.
 * Order matters: deleted > media > missed call > forwarded > text.
 */
export function classifyBody(text: string): ClassifiedBody {
  const trimmed = text.trim();

  if (DELETED_MARKERS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "deleted", body: null, mediaFilename: null, isForwarded: false };
  }

  if (MEDIA_PLACEHOLDER.test(trimmed)) {
    return { kind: "media", body: null, mediaFilename: null, isForwarded: false };
  }

  const attached = MEDIA_ATTACHED.exec(trimmed);
  if (attached?.groups?.filename) {
    return {
      kind: "media",
      body: null,
      mediaFilename: attached.groups.filename,
      isForwarded: false,
    };
  }

  if (MISSED_CALL.test(trimmed)) {
    return { kind: "missed_call", body: null, mediaFilename: null, isForwarded: false };
  }

  // Forwarded messages start with a "Forwarded" marker on its own line.
  const lines = trimmed.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const isForwarded = FORWARDED_PREFIX.test(firstLine);
  const body = isForwarded ? lines.slice(1).join("\n").trim() : trimmed;

  return {
    kind: "text",
    body: body.length > 0 ? body : null,
    mediaFilename: null,
    isForwarded,
  };
}

function isSystemLine(text: string): boolean {
  return SYSTEM_PREFIXES.some((pattern) => pattern.test(text.trim()));
}

/**
 * Parses an entire export.
 *
 * Continuation lines (a message that spans several lines) are appended to the
 * previous message. A leading run of continuation lines before any header is
 * reported as a warning instead of being silently dropped.
 */
export function parseWhatsAppExport(input: string, options: ParseOptions = {}): ParseResult {
  const dateOrder = options.dateOrder ?? "DMY";
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;

  const rawLines = input.split(/\r\n|\r|\n/);
  const messages: ParsedMessage[] = [];
  const warnings: ParseWarning[] = [];
  const participantOrder: string[] = [];
  const seenParticipants = new Set<string>();

  // Track whether a message body already reached the DB column limit, so the
  // truncation is reported rather than being invisible.
  let truncated = false;
  let pendingRawLines: string[] = [];

  const noteParticipant = (label: string) => {
    const key = label.toLowerCase();
    if (seenParticipants.has(key)) return;
    seenParticipants.add(key);
    participantOrder.push(label);
  };

  const flushWarnings = () => {
    if (pendingRawLines.length === 0) return;
    warnings.push({
      code: "unparsed_line",
      line: 1,
      message: `${pendingRawLines.length} line(s) at the start of the file did not look like messages.`,
      excerpt: pendingRawLines.slice(0, 3).join(" ").slice(0, 160),
    });
    pendingRawLines = [];
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNumber = index + 1;
    const cleaned = stripInvisibles(rawLines[index] ?? "");
    const header = matchHeader(cleaned);

    if (!header) {
      const previous = messages[messages.length - 1];

      if (previous && cleaned.trim().length > 0) {
        // Continuation of the previous message.
        const currentBody = previous.body ?? "";
        if (currentBody.length >= 10_000) {
          truncated = true;
        } else {
          previous.body = `${currentBody}\n${cleaned}`.trim();
          previous.rawLine = `${previous.rawLine}\n${cleaned}`;
        }
        continue;
      }

      if (messages.length === 0) {
        if (cleaned.trim().length > 0) pendingRawLines.push(cleaned.trim());
        continue;
      }

      // Blank line after messages: harmless, ignore.
      if (cleaned.trim().length === 0) continue;

      warnings.push({
        code: "unparsed_line",
        line: lineNumber,
        message: "Line did not match a known WhatsApp format and was skipped.",
        excerpt: cleaned.slice(0, 160),
      });
      continue;
    }

    flushWarnings();

    if (messages.length >= maxMessages) {
      warnings.push({
        code: "truncated_message",
        line: lineNumber,
        message: `Stopped after ${maxMessages} messages to protect processing time.`,
      });
      break;
    }

    const sentAt = parseTimestamp(header.datePart, header.timePart, dateOrder);
    const remainder = header.remainder.trim();

    if (!sentAt) {
      warnings.push({
        code: "invalid_timestamp",
        line: lineNumber,
        message: `Could not read the date "${header.datePart} ${header.timePart}".`,
        excerpt: cleaned.slice(0, 160),
      });
      continue;
    }

    // Only Android separates sender with ": ". A system line has no sender.
    const separator = remainder.indexOf(": ");

    if (separator === -1) {
      if (!isSystemLine(remainder) && remainder.length > 0) {
        warnings.push({
          code: "missing_sender",
          line: lineNumber,
          message: "Message header had no sender prefix; treated as a system line.",
          excerpt: remainder.slice(0, 160),
        });
      }
      messages.push({
        lineNumber,
        senderLabel: null,
        sentAt,
        kind: "system",
        body: remainder.length > 0 ? remainder : null,
        mediaFilename: null,
        isForwarded: false,
        rawLine: cleaned,
      });
      continue;
    }

    const senderLabel = remainder.slice(0, separator).trim();
    const text = remainder.slice(separator + 2);

    // A bare "Sender:" with no text is a real (empty) message in some exports.
    if (senderLabel.length === 0 || senderLabel.length > 160) {
      warnings.push({
        code: "missing_sender",
        line: lineNumber,
        message: "Could not determine the sender for this message.",
        excerpt: cleaned.slice(0, 160),
      });
      messages.push({
        lineNumber,
        senderLabel: null,
        sentAt,
        kind: "system",
        body: text.length > 0 ? text : null,
        mediaFilename: null,
        isForwarded: false,
        rawLine: cleaned,
      });
      continue;
    }

    noteParticipant(senderLabel);

    const classified = classifyBody(text);

    messages.push({
      lineNumber,
      senderLabel,
      sentAt,
      kind: classified.kind,
      body: classified.body,
      mediaFilename: classified.mediaFilename,
      isForwarded: classified.isForwarded,
      rawLine: cleaned,
    });
  }

  flushWarnings();

  if (truncated) {
    warnings.push({
      code: "truncated_message",
      line: 0,
      message: "One or more messages were longer than 10,000 characters and were truncated.",
    });
  }

  const parsedLines = messages.length + warnings.filter((w) => w.code === "unparsed_line").length;

  return {
    messages,
    warnings,
    totalLines: rawLines.length,
    skippedLines: Math.max(rawLines.length - parsedLines, 0),
    detectedParticipants: participantOrder,
  };
}

/**
 * Decides which side of the conversation each message came from.
 *
 * `selfLabels` are the labels in the export that belong to the Moti user
 * (WhatsApp exports usually label this "You", but not always). Anything not in
 * that list is incoming. When no label can be identified, every message is
 * marked "unknown" instead of guessing, which is why `direction` has an
 * explicit unknown state in the schema.
 */
export function resolveDirections(
  messages: ParsedMessage[],
  selfLabels: readonly string[],
): Array<{ direction: "outgoing" | "incoming" | "system" | "unknown" }> {
  const normalisedSelf = new Set(selfLabels.map((label) => label.trim().toLowerCase()));

  return messages.map((message) => {
    if (message.kind === "system" || !message.senderLabel) {
      return { direction: "system" as const };
    }
    if (normalisedSelf.size === 0) {
      return { direction: "unknown" as const };
    }
    return {
      direction: normalisedSelf.has(message.senderLabel.trim().toLowerCase())
        ? ("outgoing" as const)
        : ("incoming" as const),
    };
  });
}

/**
 * Suggests which label probably represents the Moti user.
 *
 * Only "You" and "Me" are treated as self, because those are unambiguous.
 * A participant count of exactly two is required: in a group chat we refuse to
 * guess rather than attributing the wrong person's words to the user.
 */
export function suggestSelfLabels(detectedParticipants: readonly string[]): {
  labels: string[];
  confident: boolean;
  reason: string;
} {
  const normalised = detectedParticipants.map((label) => label.trim().toLowerCase());
  const obvious = detectedParticipants.filter((label) =>
    ["you", "me"].includes(label.trim().toLowerCase()),
  );

  if (obvious.length > 0) {
    return {
      labels: obvious,
      confident: true,
      reason: `The export labels your own messages as "${obvious.join('", "')}".`,
    };
  }

  if (normalised.length === 2) {
    return {
      labels: [],
      confident: false,
      reason:
        'Two participants were found but neither is labelled "You". Choose which one is you before analysis.',
    };
  }

  return {
    labels: [],
    confident: false,
    reason:
      normalised.length > 2
        ? "This looks like a group conversation. Moti AI analyses one-to-one chats, so pick the participant to focus on."
        : "No participants were detected in this file.",
  };
}
