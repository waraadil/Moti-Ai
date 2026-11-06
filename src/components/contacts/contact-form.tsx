"use client";

import { useActionState, useRef } from "react";
import { createContactAction, type ActionResult } from "@/app/contacts/actions";

const INITIAL: ActionResult = { ok: true, message: "" };

const RELATIONSHIP_OPTIONS = [
  { value: "unknown", label: "Not specified" },
  { value: "family", label: "Family" },
  { value: "partner", label: "Partner" },
  { value: "friend", label: "Friend" },
  { value: "colleague", label: "Colleague" },
  { value: "acquaintance", label: "Acquaintance" },
  { value: "client", label: "Client" },
  { value: "other", label: "Other" },
] as const;

/**
 * Add-contact form.
 * Saves to the database via a server action; no optimistic fake rows.
 */
export function ContactForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState(
    async (_previous: ActionResult, formData: FormData) => {
      const result = await createContactAction(formData);
      if (result.ok) formRef.current?.reset();
      return result;
    },
    INITIAL,
  );

  const fieldErrors = state.fieldErrors ?? {};
  const showMessage = state.message.length > 0;

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate>
      {showMessage ? (
        <p
          role="status"
          className={
            state.ok
              ? "text-positive rounded-lg border border-[oklch(0.86_0.06_155)] bg-[oklch(0.96_0.03_155)] px-3 py-2 text-sm"
              : "text-danger rounded-lg border border-[oklch(0.87_0.06_25)] bg-[oklch(0.96_0.03_25)] px-3 py-2 text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="displayName" className="text-ink block text-sm font-medium">
            Name
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            maxLength={160}
            placeholder="Exactly as they appear in your chat"
            aria-invalid={fieldErrors.displayName ? true : undefined}
            className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          />
          {fieldErrors.displayName ? (
            <p className="text-danger mt-1 text-xs">{fieldErrors.displayName}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="relationshipKind" className="text-ink block text-sm font-medium">
            Relationship
          </label>
          <select
            id="relationshipKind"
            name="relationshipKind"
            defaultValue="unknown"
            className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          >
            {RELATIONSHIP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="phoneNumber" className="text-ink block text-sm font-medium">
            Phone <span className="text-ink-faint font-normal">(optional)</span>
          </label>
          <input
            id="phoneNumber"
            name="phoneNumber"
            type="tel"
            inputMode="tel"
            placeholder="+447700900123"
            aria-invalid={fieldErrors.phoneNumber ? true : undefined}
            className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          />
          {fieldErrors.phoneNumber ? (
            <p className="text-danger mt-1 text-xs">{fieldErrors.phoneNumber}</p>
          ) : (
            <p className="text-ink-faint mt-1 text-xs">
              Used only to keep two contacts distinct. Never sent anywhere.
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="notes" className="text-ink block text-sm font-medium">
            Notes <span className="text-ink-faint font-normal">(optional)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={4000}
            placeholder="How you know them, anything worth remembering"
            className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="bg-accent rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Saving…" : "Add contact"}
      </button>
    </form>
  );
}
