/**
 * Dry-run parse endpoint.
 *
 * Lets a signed-in user preview how an export will be read (participants,
 * message count, warnings) before anything is written. Nothing is persisted, so
 * it is safe to call repeatedly while figuring out the date format.
 */

import { NextResponse, type NextRequest } from "next/server";
import { toErrorResponse, ValidationError } from "@/lib/errors";
import { MAX_UPLOAD_BYTES } from "@/lib/validation/schemas";
import { parseWhatsAppExport, suggestSelfLabels } from "@/lib/conversations/parser";
import { requireSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    // Previewing still requires a session: exports are private data.
    await requireSession();

    const formData = await request.formData();
    const file = formData.get("file");
    const dateOrder = formData.get("dateOrder") === "MDY" ? "MDY" : "DMY";

    if (!(file instanceof File)) {
      throw new ValidationError({ file: "Attach the exported .txt file." });
    }

    if (file.size === 0) {
      throw new ValidationError({ file: "That file is empty." });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError({ file: "Exports must be 50 MB or smaller." });
    }

    const content = await file.text();
    const parsed = parseWhatsAppExport(content, { dateOrder });
    const suggestion = suggestSelfLabels(parsed.detectedParticipants);

    return NextResponse.json({
      parsedMessages: parsed.messages.length,
      totalLines: parsed.totalLines,
      skippedLines: parsed.skippedLines,
      detectedParticipants: parsed.detectedParticipants,
      selfLabelSuggestion: suggestion,
      warnings: parsed.warnings.slice(0, 50),
      warningCount: parsed.warnings.length,
      // A short, non-content preview so the user can confirm attribution.
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
