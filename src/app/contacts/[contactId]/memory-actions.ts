"use server";

/**
 * Memory correction actions.
 *
 * Phase 2 requires memories to be correctable and deletable. Both are honoured
 * without losing history:
 *   - "correct" inserts the corrected memory and supersedes the original,
 *   - "delete" archives it (and its evidence stays attached to the archived row).
 *
 * Nothing is ever hard-deleted here, so a wrong correction can be traced back to
 * what Moti originally recorded.
 */

import { revalidatePath } from "next/cache";
import { isAppError } from "@/lib/errors";
import { memoryCorrectionSchema } from "@/lib/validation/schemas";
import { requireSession } from "@/server/auth/session";
import {
  archiveMemory,
  createMemory,
  DuplicateMemoryError,
  supersedeMemory,
} from "@/server/memories/repository";

export type MemoryActionResult = {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
};

function revalidateContact(contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
}

export async function createMemoryAction(formData: FormData): Promise<MemoryActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return { ok: false, message: "Missing contact." };

  const parsed = memoryCorrectionSchema.safeParse({
    category: formData.get("category"),
    statement: formData.get("statement"),
    details: formData.get("details") || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: toFieldErrors(parsed.error.issues),
    };
  }

  try {
    const { supabase, userId } = await requireSession();
    await createMemory(supabase, userId, contactId, {
      category: parsed.data.category,
      statement: parsed.data.statement,
      details: parsed.data.details,
      confidence: 1,
    });
    revalidateContact(contactId);
    return { ok: true, message: "Memory added and marked as confirmed by you." };
  } catch (error) {
    return toFailure(error, "Could not save that memory. Please try again.");
  }
}

export async function correctMemoryAction(formData: FormData): Promise<MemoryActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const memoryId = String(formData.get("memoryId") ?? "");
  if (!contactId || !memoryId) return { ok: false, message: "Missing memory." };

  const parsed = memoryCorrectionSchema.safeParse({
    category: formData.get("category"),
    statement: formData.get("statement"),
    details: formData.get("details") || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: toFieldErrors(parsed.error.issues),
    };
  }

  try {
    const { supabase, userId } = await requireSession();
    await supersedeMemory(supabase, userId, memoryId, {
      category: parsed.data.category,
      statement: parsed.data.statement,
      details: parsed.data.details,
    });
    revalidateContact(contactId);
    return {
      ok: true,
      message: "Corrected. The original stays in your history as superseded.",
    };
  } catch (error) {
    return toFailure(error, "Could not correct that memory. Please try again.");
  }
}

export async function archiveMemoryAction(formData: FormData): Promise<MemoryActionResult> {
  const contactId = String(formData.get("contactId") ?? "");
  const memoryId = String(formData.get("memoryId") ?? "");
  if (!contactId || !memoryId) return { ok: false, message: "Missing memory." };

  try {
    const { supabase, userId } = await requireSession();
    await archiveMemory(supabase, userId, memoryId);
    revalidateContact(contactId);
    return { ok: true, message: "Memory archived. Its evidence is kept." };
  } catch (error) {
    return toFailure(error, "Could not archive that memory. Please try again.");
  }
}

function toFieldErrors(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return fieldErrors;
}

function toFailure(error: unknown, fallback: string): MemoryActionResult {
  if (error instanceof DuplicateMemoryError) {
    return {
      ok: false,
      message:
        "An active memory already states this. Correct or archive that one instead of adding a duplicate.",
    };
  }
  if (isAppError(error)) return { ok: false, message: error.userMessage };
  console.error("[moti] memory action failed", error);
  return { ok: false, message: fallback };
}
