"use client";

import { useActionState } from "react";
import { discardImportAction, type ConfirmActionResult } from "@/app/imports/actions";
import { ParticipantConfirm } from "./participant-confirm";

const INITIAL: ConfirmActionResult = { ok: true, message: "" };

/**
 * Confirmation panel for an import that was parked as `needs_review`.
 *
 * Rendered from the imports page so a user can come back later, confirm
 * participants and store the messages — or discard the import, which also
 * removes the uploaded file from Storage.
 */
export function PendingImport({
  importId,
  filename,
  participants,
  contacts,
  defaultContactId,
  dateOrder,
  parsedMessages,
  note,
}: {
  importId: string;
  filename: string;
  participants: string[];
  contacts: Array<{ id: string; name: string }>;
  defaultContactId: string;
  dateOrder: "DMY" | "MDY";
  parsedMessages: number;
  note: string | null;
}) {
  const [discardState, discardAction, discardPending] = useActionState(
    async (_previous: ConfirmActionResult, formData: FormData) => discardImportAction(formData),
    INITIAL,
  );

  if (discardState.ok && discardState.message.length > 0) {
    return (
      <p
        role="status"
        className="border-border-subtle bg-surface-sunken text-ink-soft rounded-lg border px-3 py-2 text-xs"
      >
        {discardState.message}
      </p>
    );
  }

  return (
    <div className="border-border-subtle mt-3 space-y-4 border-t pt-4">
      <p className="text-ink-faint text-xs">
        <span className="text-ink-soft font-medium">{filename}</span> was read but not stored yet.
        {note ? ` ${note}` : ""}
      </p>

      <ParticipantConfirm
        importId={importId}
        contacts={contacts}
        participants={participants}
        suggestedSelfLabels={[]}
        selfLabelConfident={false}
        reason={note}
        parsedMessages={parsedMessages}
        dateOrder={dateOrder}
        defaultContactId={defaultContactId}
      />

      <form action={discardAction}>
        <input type="hidden" name="importId" value={importId} />
        <button
          type="submit"
          disabled={discardPending}
          className="text-danger text-xs font-medium underline-offset-2 hover:underline disabled:opacity-60"
        >
          {discardPending ? "Discarding…" : "Discard this import and delete the uploaded file"}
        </button>
        {discardState.message.length > 0 && !discardState.ok ? (
          <span className="text-danger ml-2 text-xs">{discardState.message}</span>
        ) : null}
      </form>
    </div>
  );
}
