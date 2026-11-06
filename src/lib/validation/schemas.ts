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

const ALLOWED_UPLOAD_EXTENSIONS = [".txt", ".zip"] as const;

export const importUploadMetaSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (name) => ALLOWED_UPLOAD_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
      "Upload the .txt or .zip file WhatsApp exported, unmodified.",
    ),
  byteSize: z
    .number()
    .int()
    .positive("The file appears to be empty.")
    .max(MAX_UPLOAD_BYTES, "Exports must be 50 MB or smaller."),
  contactId: z.uuid().optional(),
});

export type ImportUploadMeta = z.infer<typeof importUploadMetaSchema>;

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
