"use client";

import { useActionState } from "react";
import {
  deleteContactDataAction,
  deleteEverythingAction,
  type DataActionResult,
} from "@/app/settings/data-actions";

const INITIAL: DataActionResult = { ok: true, message: "" };

function Feedback({ state }: { state: DataActionResult }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? "status" : "alert"} className="mt-2">
      <p className={`text-xs ${state.ok ? "text-ink-soft" : "text-danger"}`}>{state.message}</p>
      {state.detail ? <p className="text-ink-faint mt-1 text-xs">{state.detail}</p> : null}
    </div>
  );
}

export function DeleteContactForm({
  contactId,
  contactName,
}: {
  contactId: string;
  contactName: string;
}) {
  const [state, action, isPending] = useActionState(
    async (_previous: DataActionResult, formData: FormData) => deleteContactDataAction(formData),
    INITIAL,
  );

  return (
    <form action={action} className="border-border rounded-lg border p-3">
      <input type="hidden" name="contactId" value={contactId} />
      <p className="text-ink text-sm font-medium">{contactName}</p>
      <p className="text-ink-faint mt-1 text-xs">
        Removes this conversation, its imports, its analysis and any prepared replies. This cannot
        be undone.
      </p>
      <label htmlFor={`confirm-${contactId}`} className="text-ink-soft mt-2 block text-xs">
        Type <code className="text-ink">delete this conversation</code> to confirm
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id={`confirm-${contactId}`}
          name="confirmation"
          autoComplete="off"
          className="border-border-strong bg-surface text-ink flex-1 rounded-lg border px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={isPending}
          className="border-danger/50 text-danger hover:bg-danger/10 rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function DeleteEverythingForm() {
  const [state, action, isPending] = useActionState(
    async (_previous: DataActionResult, formData: FormData) => deleteEverythingAction(formData),
    INITIAL,
  );

  return (
    <form action={action}>
      <p className="text-ink-soft text-sm">
        Deletes every contact, message, import file, memory, analysis, draft and Away Mode record
        you own. Your sign-in account remains.
      </p>
      <label htmlFor="confirm-all" className="text-ink-soft mt-3 block text-xs">
        Type <code className="text-ink">delete everything</code> to confirm
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id="confirm-all"
          name="confirmation"
          autoComplete="off"
          className="border-border-strong bg-surface text-ink flex-1 rounded-lg border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={isPending}
          className="bg-danger text-danger-ink rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {isPending ? "Deleting…" : "Delete all my data"}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
