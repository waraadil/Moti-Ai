"use client";

import { useActionState } from "react";
import { useRef } from "react";
import { uploadAndParseImportAction, type ImportActionResult } from "@/app/imports/actions";

const INITIAL: ImportActionResult = { ok: true, message: "" };

/**
 * Upload form for a WhatsApp .txt export.
 *
 * The result panel shows what was actually parsed (message count, participants,
 * warnings) so success is verifiable rather than assumed.
 */
export function ImportForm({ contacts }: { contacts: Array<{ id: string; name: string }> }) {
  const formRef = useRef<HTMLFormElement>(null);

  const [state, formAction, isPending] = useActionState(
    async (_previous: ImportActionResult, formData: FormData) => {
      const result = await uploadAndParseImportAction(formData);
      if (result.ok) formRef.current?.reset();
      return result;
    },
    INITIAL,
  );

  const showMessage = state.message.length > 0;

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div>
        <label htmlFor="contactId" className="text-ink block text-sm font-medium">
          Contact
        </label>
        <select
          id="contactId"
          name="contactId"
          required
          className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none sm:max-w-sm"
        >
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="file" className="text-ink block text-sm font-medium">
          Export file
        </label>
        <input
          id="file"
          name="file"
          type="file"
          required
          accept=".txt,.zip,text/plain"
          className="border-border-strong bg-surface-raised file:bg-surface-sunken file:text-ink-soft mt-1.5 block w-full cursor-pointer rounded-lg border px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-medium"
        />
        <p className="text-ink-faint mt-1 text-xs">.txt export, up to 50 MB.</p>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="bg-accent rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Uploading and parsing…" : "Upload and parse"}
      </button>

      {showMessage ? (
        <div
          role="status"
          className={
            state.ok && !state.needsReview
              ? "text-positive rounded-lg border border-[oklch(0.86_0.06_155)] bg-[oklch(0.96_0.03_155)] px-3 py-2.5 text-sm"
              : "text-caution rounded-lg border border-[oklch(0.88_0.06_75)] bg-[oklch(0.97_0.03_75)] px-3 py-2.5 text-sm"
          }
        >
          <p className="font-medium">{state.message}</p>
          {state.stats ? (
            <ul className="text-ink-soft mt-1.5 space-y-0.5 text-xs">
              <li>Messages stored: {state.stats.messages.toLocaleString("en-GB")}</li>
              <li>
                Participants detected:{" "}
                {state.stats.participants.length > 0 ? state.stats.participants.join(", ") : "none"}
              </li>
              <li>Lines skipped: {state.stats.skippedLines}</li>
              <li>Parser warnings: {state.stats.warnings}</li>
            </ul>
          ) : null}
          {state.needsReview ? (
            <p className="mt-2 text-xs">
              The file is stored but no messages were written, because Moti AI will not guess which
              participant is you. Sender mapping is the next milestone.
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
