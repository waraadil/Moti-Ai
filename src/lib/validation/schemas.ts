/**
 * Zod schemas for every value that crosses a trust boundary: form input,
 * route handler bodies and query strings.
 *
 * Database constraints are the backstop; these give fast, specific feedback
 * before a round-trip. Keep the two in sync when the schema changes.
 */

import { z } from "zod";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // matches the storage bucket limit

export const relationshipKindSchema = z.enum([
  "family",
  "friend",
  "partner",
  "colleague",
  "acquaintance",
  "client",
  "other",
  "unknown",
]);

export const participantScopeSchema = z.enum(["self", "contact"]);

export const memoryCategorySchema = z.enum([
  "preference",
  "life_event",
  "relationship",
  "boundary",
  "goal",
  "routine",
  "sensitive",
]);

// --------------------------------------------------------------------------
// Contacts
// --------------------------------------------------------------------------

/** Accepts "+447700900123" or "07700900123"; stores what the user typed. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{6,20}$/, "Use digits only, with an optional leading +.");

export const createContactSchema = z.object({
  displayName: z.string().trim().min(1, "A name is required.").max(160),
  relationshipKind: relationshipKindSchema.default("unknown"),
  phoneNumber: phoneSchema.optional().or(z.literal("").transform(() => undefined)),
  whatsappJid: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(4000).optional(),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    relationshipKind: relationshipKindSchema.optional(),
    relationshipContextId: z.uuid().optional(),
    notes: z.string().trim().max(4000).optional(),
    isArchived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update.",
  });

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

// --------------------------------------------------------------------------
// Memory / context correction
// --------------------------------------------------------------------------

export const createMemorySchema = z.object({
  category: memoryCategorySchema,
  statement: z.string().trim().min(1, "Describe the memory.").max(500),
  details: z.string().trim().max(4000).optional(),
  topics: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0),
  isSensitive: z.boolean().default(false),
});

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

// --------------------------------------------------------------------------
// Imports
// --------------------------------------------------------------------------

/**
 * Only plain-text exports are accepted.
 *
 * `.zip` exports are rejected on purpose: the archive must be unpacked and the
 * inner chat file chosen deliberately, and the current pipeline stores exactly
 * one text file. Advertising zip support we do not have would be a lie.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [".txt"] as const;

export const dateOrderSchema = z.enum(["DMY", "MDY"]).default("DMY");

export type DateOrder = z.infer<typeof dateOrderSchema>;

export const importUploadMetaSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (name) => ALLOWED_UPLOAD_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
      "Upload the .txt export WhatsApp produced. .zip archives are not supported yet: unzip it and upload the chat .txt file.",
    ),
  byteSize: z
    .number()
    .int()
    .positive("The file appears to be empty.")
    .max(MAX_UPLOAD_BYTES, "Exports must be 50 MB or smaller."),
  contactId: z.uuid(),
  dateOrder: dateOrderSchema,
});

export type ImportUploadMeta = z.infer<typeof importUploadMetaSchema>;

/**
 * Confirms which participant is the Moti user before any messages are written.
 * `selfLabels` accepts several labels because some exports alternate between
 * "You" and a display name for the same person.
 */
export const confirmParticipantsSchema = z.object({
  importId: z.uuid(),
  contactId: z.uuid(),
  selfLabels: z.array(z.string().trim().min(1).max(160)).min(1, "Select which participant is you."),
  dateOrder: dateOrderSchema,
});

export type ConfirmParticipantsInput = z.infer<typeof confirmParticipantsSchema>;

// --------------------------------------------------------------------------
// Pagination and search
// --------------------------------------------------------------------------

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const messageQuerySchema = paginationSchema.extend({
  before: z.iso.datetime().optional(),
  q: z.string().trim().min(2).max(200).optional(),
});

export type MessageQuery = z.infer<typeof messageQuerySchema>;

/**
 * A memory the user types or corrects by hand.
 *
 * The statement is required and bounded; category is restricted to the enum the
 * database accepts, so an invalid value fails here rather than at the insert.
 */
export const memoryCorrectionSchema = z.object({
  category: z.enum([
    "preference",
    "life_event",
    "relationship",
    "boundary",
    "goal",
    "routine",
    "sensitive",
  ]),
  statement: z
    .string()
    .trim()
    .min(3, "Describe the fact in a few words.")
    .max(500, "Keep this under 500 characters."),
  details: z.string().trim().max(2000).optional(),
});

export type MemoryCorrectionInput = z.infer<typeof memoryCorrectionSchema>;

/** Tone hint for a reply draft; free text, bounded. */
export const replyToneSchema = z.string().trim().max(40).optional();

/**
 * Away Mode settings.
 *
 * `startsAt`/`endsAt` arrive as strings from an `<input type="datetime-local">`.
 * Each is validated as a real instant rather than merely non-empty, so a typo
 * cannot produce a window that silently never applies.
 */
export const awaySettingsSchema = z
  .object({
    status: z.enum(["active", "scheduled", "off"]),
    startsAt: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !Number.isNaN(Date.parse(value)), "That start time is not a valid date.")
      .nullable(),
    endsAt: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !Number.isNaN(Date.parse(value)), "That end time is not a valid date.")
      .nullable(),
    awayMessage: z.string().trim().max(280, "Keep the away message under 280 characters.").nullable(),
    defaultPermission: z.enum(["draft_only", "silent"]),
  })
  .refine(
    (value) =>
      !value.startsAt || !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt),
    { message: "The end of the window must be after its start.", path: ["endsAt"] },
  );

export type AwaySettingsInput = z.infer<typeof awaySettingsSchema>;
