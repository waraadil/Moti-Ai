/**
 * Dry-run parse endpoint.
 *
 * Lets a signed-in user preview how an export will be read (participants,
 * message count, warnings) before anything is written. Nothing is persisted, so
 * it is safe to call repeatedly while choosing the date format.
 *
 * Uses the exact same parser, validation and participant assessment as the real
 * import, and the caller passes the same `dateOrder`, so a preview can never
 * disagree with what gets stored.
 */

import { NextResponse, type NextRequest } from "next/server";
import { toErrorResponse, ValidationError } from "@/lib/errors";
import {
  MAX_UPLOAD_BYTES,
  dateOrderSchema,
  importUploadMetaSchema,
} from "@/lib/validation/schemas";
import {
  parseWhatsAppExport,
  suggestSelfLabels,
  validateParsedExport,
} from "@/lib/conversations/parser";
import { requireSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Previewing still requires a session: exports are private data.
    await requireSession();

    const formData = await request.formData();
    const file = formData.get("file");
    const dateOrder = dateOrderSchema.parse(
      typeof formData.get("dateOrder") === "string" ? formData.get("dateOrder") : undefined,
    );

    if (!(file instanceof File)) {
      throw new ValidationError({ file: "Attach the exported .txt file." });
    }

    const meta = importUploadMetaSchema.safeParse({
      filename: file.name,
      byteSize: file.size,
      contactId: "00000000-0000-4000-8000-000000000000",
      dateOrder,
    });

    if (!meta.success) {
      throw new ValidationError(
        Object.fromEntries(
          meta.error.issues.map((issue) => [String(issue.path[0] ?? "file"), issue.message]),
        ),
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError({ file: "Exports must be 50 MB or smaller." });
    }

    const content = await file.text();
    const parsed = parseWhatsAppExport(content, { dateOrder });
    const validation = validateParsedExport(parsed);

    return NextResponse.json({
      ok: validation.ok,
      dateOrder,
      issue: validation.issue,
      parsedMessages: validation.messageCount,
      totalLines: parsed.totalLines,
      skippedLines: parsed.skippedLines,
      detectedParticipants: parsed.detectedParticipants,
      // Same assessment the import uses, so the preview cannot say "fine" when
      // the import would later reject the file.
      selfLabelSuggestion: suggestSelfLabels(parsed.detectedParticipants),
      warnings: parsed.warnings.slice(0, 50),
      warningCount: parsed.warnings.length,
      sample: parsed.messages.slice(0, 5).map((message) => ({
        lineNumber: message.lineNumber,
        senderLabel: message.senderLabel,
        sentAt: message.sentAt?.toISOString() ?? null,
        kind: message.kind,
        excerpt: message.body?.slice(0, 160) ?? null,
      })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
