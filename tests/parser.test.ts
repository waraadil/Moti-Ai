import { describe, expect, it } from "vitest";
import {
  classifyBody,
  parseTimestamp,
  parseWhatsAppExport,
  resolveDirections,
  suggestSelfLabels,
} from "@/lib/conversations/parser";

// Real-shaped Android export (English, 24h clock, DMY).
const ANDROID_EXPORT = [
  "12/03/2024, 09:15 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.",
  "12/03/2024, 09:16 - Priya: Hey! Are we still on for Saturday?",
  "12/03/2024, 09:18 - You: Yes definitely. I'll bring the cake 🎂",
  "12/03/2024, 09:19 - Priya: Amazing",
  "12/03/2024, 09:19 - Priya: My sister is coming too, she just got back from Lisbon",
  "12/03/2024, 09:25 - You: <Media omitted>",
  "13/03/2024, 20:02 - Priya: IMG-20240313-WA0002.jpg (file attached)",
  "13/03/2024, 20:03 - You: This message was deleted.",
  "13/03/2024, 20:04 - Priya: Missed voice call",
  "13/03/2024, 20:10 - You: Forwarded",
  "12 March 2024 is not in this export format, sorry",
  "13/03/2024, 20:15 - Priya: talk later",
].join("\n");

// iOS-style bracketed export.
const IOS_EXPORT = [
  "[01/02/2023, 21:04:11] Mum: Did you eat?",
  "[01/02/2023, 21:05:02] You: Yes mum",
  "[01/02/2023, 21:05:30] Mum: Good",
].join("\n");

describe("parseTimestamp", () => {
  it("parses day-first dates by default", () => {
    const date = parseTimestamp("01/02/2023", "21:04");
    expect(date?.toISOString()).toBe("2023-02-01T21:04:00.000Z");
  });

  it("parses month-first dates when asked", () => {
    const date = parseTimestamp("01/02/2023", "21:04", "MDY");
    expect(date?.toISOString()).toBe("2023-01-02T21:04:00.000Z");
  });

  it("supports dots and dashes as separators", () => {
    expect(parseTimestamp("31.12.2023", "23:59")?.toISOString()).toBe("2023-12-31T23:59:00.000Z");
    expect(parseTimestamp("2023-12-31", "23:59")?.toISOString()).toBe("2023-12-31T23:59:00.000Z");
  });

  it("expands two-digit years", () => {
    expect(parseTimestamp("01/02/23", "10:00")?.getUTCFullYear()).toBe(2023);
    expect(parseTimestamp("01/02/98", "10:00")?.getUTCFullYear()).toBe(1998);
  });

  it("handles 12-hour clocks", () => {
    expect(parseTimestamp("01/02/2023", "09:41 pm")?.getUTCHours()).toBe(21);
    expect(parseTimestamp("01/02/2023", "12:15 am")?.getUTCHours()).toBe(0);
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseTimestamp("31/02/2023", "10:00")).toBeNull();
    expect(parseTimestamp("13/13/2023", "10:00")).toBeNull();
  });

  it("rejects malformed times", () => {
    expect(parseTimestamp("01/02/2023", "25:00")).toBeNull();
    expect(parseTimestamp("01/02/2023", "nonsense")).toBeNull();
  });
});

describe("classifyBody", () => {
  it("detects media placeholders", () => {
    expect(classifyBody("<Media omitted>").kind).toBe("media");
    expect(classifyBody("sticker omitted").kind).toBe("media");
  });

  it("extracts attached filenames", () => {
    const result = classifyBody("IMG-20240313-WA0002.jpg (file attached)");
    expect(result.kind).toBe("media");
    expect(result.mediaFilename).toBe("IMG-20240313-WA0002.jpg");
  });

  it("detects deleted messages in both languages of wording", () => {
    expect(classifyBody("This message was deleted.").kind).toBe("deleted");
    expect(classifyBody("You deleted this message").kind).toBe("deleted");
  });

  it("detects missed calls", () => {
    expect(classifyBody("Missed voice call").kind).toBe("missed_call");
  });

  it("strips the forwarded marker", () => {
    const result = classifyBody("Forwarded\nHave you seen this?");
    expect(result.isForwarded).toBe(true);
    expect(result.body).toBe("Have you seen this?");
  });

  it("keeps ordinary text intact, including colons", () => {
    const result = classifyBody("Meeting at 10:30: don't be late");
    expect(result.kind).toBe("text");
    expect(result.body).toBe("Meeting at 10:30: don't be late");
  });
});

describe("parseWhatsAppExport", () => {
  it("parses an Android export", () => {
    const result = parseWhatsAppExport(ANDROID_EXPORT);

    expect(result.messages).toHaveLength(11);
    expect(result.detectedParticipants).toEqual(["Priya", "You"]);

    const first = result.messages[0];
    expect(first?.senderLabel).toBeNull();
    expect(first?.kind).toBe("system");

    const second = result.messages[1];
    expect(second?.senderLabel).toBe("Priya");
    expect(second?.body).toBe("Hey! Are we still on for Saturday?");
    expect(second?.sentAt?.toISOString()).toBe("2024-03-12T09:16:00.000Z");
    expect(second?.lineNumber).toBe(2);
  });

  it("preserves message kinds and media metadata", () => {
    const { messages } = parseWhatsAppExport(ANDROID_EXPORT);
    const kinds = messages.map((message) => message.kind);
    expect(kinds).toContain("media");
    expect(kinds).toContain("deleted");
    expect(kinds).toContain("missed_call");

    const media = messages.find((message) => message.mediaFilename !== null);
    expect(media?.mediaFilename).toBe("IMG-20240313-WA0002.jpg");
  });

  it("appends continuation lines to the previous message", () => {
    const { messages } = parseWhatsAppExport(ANDROID_EXPORT);
    const priyaForwarded = messages.find((message) => message.isForwarded);
    // "Forwarded" alone has no body; the following stray line becomes its body.
    expect(priyaForwarded?.body).toContain("12 March 2024");
  });

  it("parses an iOS bracketed export", () => {
    const result = parseWhatsAppExport(IOS_EXPORT);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.senderLabel).toBe("Mum");
    expect(result.messages[0]?.sentAt?.toISOString()).toBe("2023-02-01T21:04:11.000Z");
  });

  it("reports unparsed leading lines as warnings instead of dropping them", () => {
    const result = parseWhatsAppExport(
      ["Some header junk", "more junk", "12/03/2024, 09:16 - Priya: hi"].join("\n"),
    );
    expect(result.warnings.some((warning) => warning.code === "unparsed_line")).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it("warns about invalid timestamps and does not invent a value", () => {
    const result = parseWhatsAppExport(
      ["31/02/2024, 09:16 - Priya: impossible date", "12/03/2024, 09:16 - Priya: fine"].join("\n"),
    );
    expect(result.warnings.some((warning) => warning.code === "invalid_timestamp")).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it("marks rows with no sender as system messages with a warning", () => {
    const result = parseWhatsAppExport("12/03/2024, 09:16 - something happened without a colon");
    expect(result.messages[0]?.kind).toBe("system");
    expect(result.warnings.some((warning) => warning.code === "missing_sender")).toBe(true);
  });

  it("returns an empty result for empty input rather than throwing", () => {
    const result = parseWhatsAppExport("");
    expect(result.messages).toEqual([]);
    expect(result.totalLines).toBe(1);
  });

  it("strips zero-width direction marks", () => {
    const withMarks = "\u200e12/03/2024, 09:16 - \u200ePriya: hello\u200e";
    const result = parseWhatsAppExport(withMarks);
    expect(result.messages[0]?.senderLabel).toBe("Priya");
    expect(result.messages[0]?.body).toBe("hello");
  });

  it("respects the maxMessages guard", () => {
    const lines = Array.from(
      { length: 50 },
      (_, index) => `12/03/2024, 09:16 - Priya: message ${index}`,
    );
    const result = parseWhatsAppExport(lines.join("\n"), { maxMessages: 10 });
    expect(result.messages).toHaveLength(10);
    expect(result.warnings.some((warning) => warning.code === "truncated_message")).toBe(true);
  });
});

describe("resolveDirections", () => {
  it("maps self labels to outgoing and everything else to incoming", () => {
    const { messages } = parseWhatsAppExport(ANDROID_EXPORT);
    const directions = resolveDirections(messages, ["You"]).map((entry) => entry.direction);

    expect(directions[0]).toBe("system");
    expect(directions[1]).toBe("incoming");
    expect(directions[2]).toBe("outgoing");
  });

  it("refuses to guess when no self label is known", () => {
    const { messages } = parseWhatsAppExport(IOS_EXPORT);
    const directions = resolveDirections(messages, []).map((entry) => entry.direction);
    expect(directions.every((direction) => direction === "unknown")).toBe(true);
  });

  it("is case-insensitive about labels", () => {
    const { messages } = parseWhatsAppExport(IOS_EXPORT);
    const directions = resolveDirections(messages, ["you"]).map((entry) => entry.direction);
    expect(directions[1]).toBe("outgoing");
  });
});

describe("suggestSelfLabels", () => {
  it("accepts an explicit You label", () => {
    const suggestion = suggestSelfLabels(["Priya", "You"]);
    expect(suggestion).toMatchObject({ labels: ["You"], confident: true });
  });

  it("does not guess between two unlabelled participants", () => {
    const suggestion = suggestSelfLabels(["Alice", "Bob"]);
    expect(suggestion.confident).toBe(false);
    expect(suggestion.labels).toEqual([]);
    expect(suggestion.reason).toMatch(/choose which one is you/i);
  });

  it("flags group conversations instead of analysing the wrong person", () => {
    const suggestion = suggestSelfLabels(["Alice", "Bob", "Carol"]);
    expect(suggestion.confident).toBe(false);
    expect(suggestion.reason).toMatch(/group/i);
  });
});
