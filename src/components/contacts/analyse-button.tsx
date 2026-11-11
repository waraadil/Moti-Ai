"use client";

import { useActionState } from "react";
import { runAnalysisAction, type AnalyseResult } from "@/app/contacts/[contactId]/analysis-actions";

const INITIAL: AnalyseResult = { ok: true, message: "" };

/**
 * Triggers a real analysis run.
 * Reports the engine's actual outcome, including refusals and cached results —
 * there is no optimistic "Analysed!" state here.
 */
export function AnalyseButton({
  contactId,
  label = "Analyse conversation",
  disabled = false,
}: {
  contactId: string;
  label?: string;
  disabled?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(
    async (_previous: AnalyseResult, formData: FormData) => runAnalysisAction(formData),
    INITIAL,
  );

  return (
    <div className="space-y-2">
      <form action={formAction}>
        <input type="hidden" name="contactId" value={contactId} />
        <button
          type="submit"
          disabled={isPending || disabled}
          className="bg-accent rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Analysing…" : label}
        </button>
      </form>

      {state.message.length > 0 ? (
        <div role="status" className="space-y-1">
          <p className={`text-sm font-medium ${state.ok ? "text-positive" : "text-danger"}`}>
            {state.message}
          </p>
          {state.detail ? <p className="text-ink-soft text-xs">{state.detail}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
