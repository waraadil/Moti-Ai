/**
 * Synthetic conversations for the intelligence-engine tests.
 *
 * Hand-written to mirror real WhatsApp exports: typos, fragments, emoji,
 * lowercase, mixed registers, and the awkward cases (contradictions,
 * speculation, unanswered questions, third-party hearsay).
 *
 * All content is invented for testing. No real people or conversations.
 */

import type { MessageRow } from "@/lib/supabase/database.types";

/**
 * Ids are derived from the message content (sender + timestamp + body) so
 * repeated calls return identical ids — tests that cite messages rely on it.
 *
 * Shaped as a UUID because `messages.id` is a uuid column: these fixtures are
 * inserted into a real PostgreSQL instance in the SQL-level pipeline test.
 */
function stableId(sender: string, at: string, body: string): string {
  const seed = `${sender}|${at}|${body}`;
  // Four independent 32-bit hashes, formatted 8-4-4-4-12.
  const chunks: number[] = [];
  for (let round = 0; round < 4; round += 1) {
    let hash = 2166136261 ^ round;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    chunks.push(hash >>> 0);
  }

  const hex = chunks.map((chunk) => chunk.toString(16).padStart(8, "0")).join("");
  // Version 4, variant 8-b, so the value is a well-formed random-style UUID.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function message(params: {
  direction: "incoming" | "outgoing" | "system";
  sender: string;
  at: string;
  body: string;
  kind?: MessageRow["kind"];
}): MessageRow {
  const id = stableId(params.sender, params.at, params.body);
  return {
    id,
    user_id: "user-1",
    chat_import_id: "import-1",
    contact_id: "contact-1",
    direction: params.direction,
    kind: params.kind ?? "text",
    sender_label: params.kind === "system" ? null : params.sender,
    sent_at: params.at,
    body: params.body,
    raw_line: "",
    line_number: 0,
    media_filename: null,
    is_forwarded: false,
    source_fingerprint: `fixture:${id}`,
    created_at: params.at,
  };
}

/** Kept for callers that used to reset the id counter; ids are now content-derived. */
export function resetFixtureIds(): void {}

/**
 * Priya and the user, 40 messages over a week.
 * Distinct styles: Priya writes longer, warmer, asks questions; the user writes
 * short lower-case bursts with emoji.
 */
export function buildPriyaConversation(): MessageRow[] {
  // Explicit dates: this conversation is the reference fixture for temporal
  // tests, so ordering must be unambiguous rather than derived from position.
  const script: Array<[0 | 1, string, string]> = [
    [1, "hey! how did the interview go??", "2024-03-01 09:02"],
    [0, "went ok i think", "2024-03-01 09:05"],
    [0, "they said they'd let me know by friday 🙃", "2024-03-01 09:05"],
    [
      1,
      "oh nice, that's promising. Fingers crossed for you. I remember how nervous you were about it last week.",
      "2024-03-01 09:07",
    ],
    [0, "yeah was a mess lol", "2024-03-01 09:09"],
    [
      1,
      "You're always hard on yourself. I'm sure you did better than you think.",
      "2024-03-01 09:10",
    ],
    [0, "how's your marathon training going?", "2024-03-01 09:12"],
    [1, "Actually really well! I ran 18km on Sunday and my knees survived.", "2024-03-01 09:14"],
    [1, "I'm training for the Lisbon marathon in October", "2024-03-01 09:14"],
    [0, "that's mad impressive", "2024-03-01 09:16"],
    [0, "i'm planning to start running too", "2024-03-01 09:16"],
    [1, "You should! Start with 5k and don't do too much at once.", "2024-03-01 09:18"],
    [0, "noted 🙏", "2024-03-01 09:19"],
    [
      1,
      "Are we still on for Saturday? I was thinking we could try that new place on Bridge Street.",
      "2024-03-01 09:21",
    ],
    [0, "yes definitely", "2024-03-01 09:23"],
    [0, "i'll book a table", "2024-03-01 09:23"],
    [1, "Perfect. 7pm?", "2024-03-01 09:24"],
    [0, "7 works", "2024-03-01 09:25"],
    [1, "My sister is coming too, she just got back from Lisbon actually", "2024-03-01 09:26"],
    [0, "oh nice, the one who lives there?", "2024-03-01 09:27"],
    [
      1,
      "Yes! She's been there two years now. She's moving back properly in June.",
      "2024-03-01 09:29",
    ],
    [0, "that's a big move", "2024-03-01 09:31"],
    [1, "It is. She's nervous about it but I think she's ready.", "2024-03-01 09:33"],
    [0, "what's she doing for work", "2024-03-01 09:35"],
    [
      1,
      "She's a physio, so she'll find something. I'm not sure exactly where yet.",
      "2024-03-01 09:37",
    ],
    [0, "anyway i should sleep", "2024-03-01 22:04"],
    [1, "Go! Speak tomorrow.", "2024-03-01 22:05"],
    [1, "Did you book the table?", "2024-03-02 10:15"],
    [0, "booked it, 7pm saturday", "2024-03-02 11:40"],
    [1, "Amazing, thank you. I owe you one.", "2024-03-02 11:42"],
    [0, "you can buy dessert", "2024-03-02 11:43"],
    [1, "I hate running in the morning, it has to be evenings for me.", "2024-03-03 18:02"],
    [0, "noted, evenings only", "2024-03-03 18:20"],
    [1, "Also — did you hear back from the interview?", "2024-03-04 09:00"],
    [0, "not yet", "2024-03-04 09:30"],
    [1, "Fingers crossed. Let me know as soon as you hear.", "2024-03-04 09:31"],
    [0, "will do", "2024-03-04 09:33"],
    [1, "By the way my sister's move is delayed, it's July now not June.", "2024-03-05 12:00"],
    [0, "ah ok", "2024-03-05 12:10"],
    [1, "I'm not a big fan of long send-offs, so I'm skipping the party.", "2024-03-05 12:11"],
    [0, "fair enough", "2024-03-05 12:15"],
  ];

  return script.map(([side, body, stamp]) =>
    message({
      direction: side === 1 ? "incoming" : "outgoing",
      sender: side === 1 ? "Priya" : "Wara",
      at: `${stamp.replace(" ", "T")}:00.000Z`,
      body,
    }),
  );
}

/**
 * Contradiction + speculation fixture.
 * - A plan that is later cancelled.
 * - A detail that is corrected ("June" -> "July").
 * - Speculation that must not become a memory ("maybe I'll move to Berlin").
 * - Third-party hearsay that must be attributed, not asserted about the contact.
 */
export function buildContradictionConversation(): MessageRow[] {
  return [
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-01T10:00:00.000Z",
      body: "I'm moving to Manchester in May",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-04-01T10:02:00.000Z",
      body: "oh wow big news",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-01T10:03:00.000Z",
      body: "Sorry I meant June not May, the lease runs out at the end",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-02T09:00:00.000Z",
      body: "Maybe I'll move to Berlin after that, not sure yet",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-02T09:05:00.000Z",
      body: "My brother said he might visit but he always says that",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-04-02T09:10:00.000Z",
      body: "let me know if you need help moving",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-03T14:00:00.000Z",
      body: "I'm planning to book the van next week",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-04-03T14:05:00.000Z",
      body: "nice one",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-04-04T08:00:00.000Z",
      body: "Actually I cancelled the van, the move is postponed",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-04-04T08:30:00.000Z",
      body: "ok, whenever it happens",
    }),
  ];
}

/** Not enough messages to profile anyone: must be reported as insufficient. */
export function buildTinyConversation(): MessageRow[] {
  return [
    message({
      direction: "incoming",
      sender: "Sam",
      at: "2024-05-01T10:00:00.000Z",
      body: "hi",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-05-01T10:01:00.000Z",
      body: "hey",
    }),
  ];
}

/** One-sided conversation: cannot compare styles. */
export function buildOneSidedConversation(): MessageRow[] {
  return Array.from({ length: 12 }, (_, index) =>
    message({
      direction: "outgoing",
      sender: "Wara",
      at: `2024-06-01T10:${String(index).padStart(2, "0")}:00.000Z`,
      body: `message number ${index} about nothing in particular`,
    }),
  );
}

/** Same conversation as Priya's but with a later batch of messages appended. */
export function buildPriyaConversationExtended(): MessageRow[] {
  const base = buildPriyaConversation();
  return [
    ...base,
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-03-08T09:00:00.000Z",
      body: "I got the confirmation, my sister is definitely moving in July now",
    }),
    message({
      direction: "outgoing",
      sender: "Wara",
      at: "2024-03-08T09:05:00.000Z",
      body: "finally sorted",
    }),
    message({
      direction: "incoming",
      sender: "Priya",
      at: "2024-03-08T09:06:00.000Z",
      body: "I'm training for the Lisbon marathon in October by the way, not the half",
    }),
  ];
}
