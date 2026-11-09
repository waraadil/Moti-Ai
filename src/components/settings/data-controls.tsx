"use client";

import { useActionState } from "react";
import {
  deleteContactDataAction,
  deleteEverythingAction,
  retryCleanupAction,
  type DataActionResult,
} from "@/app/settings/data-actions";

const INITIAL: DataActionResult = { ok: true, complete: true, message: "" };

/**
 * Result line for a deletion.
 *
 * Three states, not two. "Partly done" is the important one: records gone but
 * files outstanding. Collapsing it into success or failure would misreport both.
 */
function Feedback({ state }: { state: DataActionResult }) {
  if (!state.message) return null;

  const tone = !state.ok ? "danger" : state.complete ? "soft" : "caution";
  const role = state.ok ? "status" : "alert";

  return (
    <div role={role} className="mt-2">
      <p
        className={`text-xs ${
          tone === "danger"
            ? "text-danger"
            : tone === "caution"
              ? "text-caution"
              : "text-ink-soft"
        }`}
      >
        {state.message}
      </p>
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

/**
 * Visible, retryable handle on outstanding file cleanup.
 *
 * This exists because a deletion can commit its rows while a stored file
 * survives. Leaving that invisible would mean telling the user everything is
 * gone when it is not, so the count and the retry button are always shown.
 */
export function PendingCleanup({
  pending,
}: {
  pending: Array<{ path: string; attempts: number; lastError: string | null }>;
}) {
  const [state, action, isPending] = useActionState(
    async (_previous: DataActionResult, _formData: FormData) => retryCleanupAction(),
    INITIAL,
  );

  if (pending.length === 0 && !state.message) return null;

  return (
    <div className="border-caution/40 bg-caution/5 mt-3 rounded-lg border p-3">
      <p className="text-ink text-sm font-medium">
        {pending.length > 0
          ? `${pending.length} stored file(s) still need removing`
          : "File cleanup finished"}
      </p>

      {pending.length > 0 ? (
        <>
          <p className="text-ink-soft mt-1 text-xs">
            Your records are deleted. These files are queued for removal and will be retried until
            they succeed. The deletion is not reported complete until they are gone.
          </p>
          <ul className="text-ink-faint mt-2 space-y-1 text-xs">
            {pending.map((item) => (
              <li key={item.path} className="truncate">
                {item.path}
                {item.attempts > 0 ? ` · ${item.attempts} attempt(s)` : ""}
                {item.lastError ? ` · ${item.lastError}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form action={action} className="mt-2">
        <button
          type="submit"
          disabled={isPending}
          className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          {isPending ? "Retrying…" : "Retry file cleanup"}
        </button>
      </form>

      <Feedback state={state} />
    </div>
  );
}
