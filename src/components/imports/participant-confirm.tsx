"use client";

import { useActionState, useState } from "react";
import { confirmImportAction, type ConfirmActionResult } from "@/app/imports/actions";
import { isDirectConversation } from "@/lib/conversations/parser";

const INITIAL: ConfirmActionResult = { ok: true, message: "" };

/**
 * Step 2 of the import: participant confirmation.
 *
 * Requirement order, made explicit in the UI:
 *   1. every detected participant is listed,
 *   2. the user picks which one is them (multi-select, because some exports
 *      alternate between "You" and the user's display name),
 *   3. the counterpart is derived and shown, not assumed,
 *   4. the contact association can be corrected here, before saving,
 *   5. nothing is written until "Confirm and store messages" is pressed.
 *
 * This is what makes exports work when the user's own name is a real WhatsApp
 * display name rather than "You".
 */
export function ParticipantConfirm({
  importId,
  contacts,
  participants,
  suggestedSelfLabels,
  selfLabelConfident,
  reason,
  parsedMessages,
  dateOrder,
  defaultContactId,
}: {
  importId: string;
  contacts: Array<{ id: string; name: string }>;
  participants: string[];
  suggestedSelfLabels: string[];
  selfLabelConfident: boolean;
  reason: string | null;
  parsedMessages: number;
  dateOrder: "DMY" | "MDY";
  defaultContactId: string;
}) {
  const [selected, setSelected] = useState<string[]>(suggestedSelfLabels);
  const [contactId, setContactId] = useState(defaultContactId);

  const [state, formAction, isPending] = useActionState(
    async (_previous: ConfirmActionResult, formData: FormData) => confirmImportAction(formData),
    INITIAL,
  );

  const toggle = (label: string) => {
    setSelected((current) =>
      current.includes(label) ? current.filter((value) => value !== label) : [...current, label],
    );
  };

  // Derive the counterpart rather than assuming it. With more than two
  // participants this is a group and no single counterpart exists.
  const others = participants.filter((label) => !selected.includes(label));
  const counterpart =
    participants.length === 2 && others.length === 1 ? (others[0] as string) : null;
  // Same rule the server applies, so the UI cannot promise something the
  // confirmation step would reject.
  const isGroup = !isDirectConversation(participants);

  const matchedContact = contacts.find((contact) => contact.id === contactId) ?? null;
  const nameMatchesCounterpart =
    counterpart !== null &&
    matchedContact !== null &&
    matchedContact.name.trim().toLowerCase() === counterpart.trim().toLowerCase();

  if (isGroup) {
    return (
      <div className="text-caution rounded-lg border border-[oklch(0.88_0.06_75)] bg-[oklch(0.97_0.03_75)] px-4 py-3 text-sm">
        <p className="font-medium">This is a group conversation</p>
        <p className="text-ink-soft mt-1">
          It contains {participants.length} participants: {participants.join(", ")}. Moti AI
          analyses one-to-one conversations only, so this file was rejected and no messages were
          stored.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="importId" value={importId} />
      <input type="hidden" name="dateOrder" value={dateOrder} />

      {/* 1. All detected participants */}
      <section>
        <h3 className="text-ink text-sm font-semibold">Participants found</h3>
        <p className="text-ink-faint mt-1 text-xs">
          {parsedMessages.toLocaleString("en-GB")} messages read · {participants.length}{" "}
          participants · dates parsed as {dateOrder === "MDY" ? "Month/Day/Year" : "Day/Month/Year"}
        </p>
        <ul className="mt-3 space-y-2">
          {participants.map((label) => {
            const isSelected = selected.includes(label);
            return (
              <li key={label}>
                <label
                  className={
                    isSelected
                      ? "border-accent bg-accent-soft flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5"
                      : "border-border-strong bg-surface-raised hover:bg-surface-sunken flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5"
                  }
                >
                  <input
                    type="checkbox"
                    name="selfLabels"
                    value={label}
                    checked={isSelected}
                    onChange={() => toggle(label)}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">
                    {label}
                  </span>
                  {isSelected ? (
                    <span className="text-accent-ink shrink-0 text-xs font-medium">This is me</span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-ink-faint mt-2 text-xs">
          Tick the name that belongs to you. Leave the other participant unticked.
        </p>
      </section>

      {/* 2. Derived counterpart */}
      <section>
        <h3 className="text-ink text-sm font-semibold">The other participant</h3>
        {counterpart ? (
          <p className="text-ink-soft mt-1.5 text-sm">
            Moti AI will treat <span className="text-ink font-medium">{counterpart}</span> as the
            contact for this conversation.
          </p>
        ) : (
          <p className="text-caution mt-1.5 text-sm">
            Select exactly one participant as yourself to identify the other person.
          </p>
        )}
      </section>

      {/* 3. Contact association, correctable */}
      <section>
        <label htmlFor="contactId" className="text-ink block text-sm font-semibold">
          Save this conversation under
        </label>
        <select
          id="contactId"
          name="contactId"
          required
          value={contactId}
          onChange={(event) => setContactId(event.target.value)}
          className="border-border-strong bg-surface-raised focus:border-accent mt-1.5 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none sm:max-w-sm"
        >
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
        {counterpart && matchedContact && !nameMatchesCounterpart ? (
          <p className="text-caution mt-2 rounded-lg border border-[oklch(0.88_0.06_75)] bg-[oklch(0.97_0.03_75)] px-3 py-2 text-xs">
            The export names this person &ldquo;{counterpart}&rdquo;, but you selected &ldquo;
            {matchedContact.name}&rdquo;. Messages will be stored under the selected contact — the
            original sender labels are preserved either way.
          </p>
        ) : null}
        {!selfLabelConfident && reason ? (
          <p className="text-ink-faint mt-2 text-xs">{reason}</p>
        ) : null}
      </section>

      <button
        type="submit"
        disabled={isPending || selected.length === 0}
        className="bg-accent rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Storing messages…" : "Confirm and store messages"}
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
