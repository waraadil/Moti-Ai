"use client";

import { useActionState, useId, useRef, useState } from "react";
import { uploadImportAction, type UploadActionResult } from "@/app/imports/actions";
import { ParticipantConfirm } from "./participant-confirm";

const INITIAL: UploadActionResult = { ok: true, message: "" };

/** Only .txt is accepted; the server enforces the same rule. */
const ACCEPT = ".txt,text/plain";

/**
 * Step 1 of the import: pick contact, date format and file.
 *
 * On success the server returns the detected participants, and this component
 * hands over to `ParticipantConfirm` — messages are not stored until the user
 * confirms who they are.
 */
export function ImportForm({ contacts }: { contacts: Array<{ id: string; name: string }> }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [dateOrder, setDateOrder] = useState<"DMY" | "MDY">("DMY");
  const dateHintId = useId();

  const [state, formAction, isPending] = useActionState(
    async (_previous: UploadActionResult, formData: FormData) => {
      const result = await uploadImportAction(formData);
      if (result.ok) formRef.current?.reset();
      return result;
    },
    INITIAL,
  );

  // Show the confirmation step instead of the form once a file is parked.
  if (state.ok && state.importId && state.review) {
    return (
      <div className="space-y-4">
        <p
          role="status"
          className="text-positive rounded-lg border border-[oklch(0.86_0.06_155)] bg-[oklch(0.96_0.03_155)] px-3 py-2.5 text-sm"
        >
          {state.message}
        </p>
        <ParticipantConfirm
          importId={state.importId}
          contacts={contacts}
          participants={state.review.participants}
          suggestedSelfLabels={state.review.suggestedSelfLabels}
          selfLabelConfident={state.review.selfLabelConfident}
          reason={state.review.reason}
          parsedMessages={state.review.parsedMessages}
          dateOrder={state.review.dateOrder === "MDY" ? "MDY" : "DMY"}
          defaultContactId={state.review.contactId}
        />
      </div>
    );
  }

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
        <p className="text-ink-faint mt-1 text-xs">
          You can change this on the next step, before anything is saved.
        </p>
      </div>

      <fieldset>
        <legend className="text-ink block text-sm font-medium">Date format</legend>
        <p id={dateHintId} className="text-ink-faint mt-1 text-xs">
          WhatsApp writes dates in your phone&apos;s locale order. If the preview dates look wrong,
          switch this and upload again.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              { value: "DMY", label: "Day/Month/Year", example: "31/12/2024 = 31 December" },
              { value: "MDY", label: "Month/Day/Year", example: "12/31/2024 = 31 December" },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={
                dateOrder === option.value
                  ? "border-accent bg-accent-soft flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  : "border-border-strong bg-surface-raised hover:bg-surface-sunken flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              }
            >
              <input
                type="radio"
                name="dateOrder"
                value={option.value}
                checked={dateOrder === option.value}
                onChange={() => setDateOrder(option.value)}
                aria-describedby={dateHintId}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              <span className="text-ink font-medium">{option.label}</span>
              <span className="text-ink-faint text-xs">{option.example}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="file" className="text-ink block text-sm font-medium">
          Export file
        </label>
        <input
          id="file"
          name="file"
          type="file"
          required
          accept={ACCEPT}
          className="border-border-strong bg-surface-raised file:bg-surface-sunken file:text-ink-soft mt-1.5 block w-full cursor-pointer rounded-lg border px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-medium"
        />
        <p className="text-ink-faint mt-1 text-xs">
          .txt only, up to 50 MB. .zip archives are not supported yet — unzip and upload the chat
          file.
        </p>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="bg-accent rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Reading file…" : "Read file"}
      </button>

      {state.message.length > 0 ? (
        <p
          role="status"
          className={
            state.ok
              ? "text-positive rounded-lg border border-[oklch(0.86_0.06_155)] bg-[oklch(0.96_0.03_155)] px-3 py-2.5 text-sm"
              : "text-danger rounded-lg border border-[oklch(0.87_0.06_25)] bg-[oklch(0.96_0.03_25)] px-3 py-2.5 text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
