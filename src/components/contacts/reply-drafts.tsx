"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/primitives";
import {
  acceptDraftAction,
  discardDraftAction,
  editDraftAction,
  generateDraftsAction,
  type ReplyActionResult,
} from "@/app/contacts/[contactId]/reply-actions";

const INITIAL: ReplyActionResult = { ok: true, message: "" };

export type DraftData = {
  id: string;
  body: string;
  editedBody: string | null;
  tone: string | null;
  status: "draft" | "accepted" | "edited" | "discarded";
  usedMemoryCount: number;
  modelProvider: string | null;
  modelName: string | null;
};

/**
 * Draft composer.
 *
 * Shows generated suggestions and lets the user accept, edit or discard them.
 * There is no send button anywhere: the accepted text is for the user to copy
 * into WhatsApp themselves. Moti AI has no outbound path.
 */
export function ReplyDrafts({
  contactId,
  drafts,
  hasAnalysis,
}: {
  contactId: string;
  drafts: DraftData[];
  hasAnalysis: boolean;
}) {
  const [generateState, generateAction, isGenerating] = useActionState(
    async (_previous: ReplyActionResult, formData: FormData) => generateDraftsAction(formData),
    INITIAL,
  );

  return (
    <div className="space-y-3">
      <form action={generateAction}>
        <input type="hidden" name="contactId" value={contactId} />
        <button
          type="submit"
          disabled={isGenerating || !hasAnalysis}
          className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isGenerating
            ? "Drafting…"
            : drafts.some((d) => d.status === "draft")
              ? "Regenerate drafts"
              : "Draft a reply"}
        </button>
      </form>

      {generateState.message.length > 0 ? (
        <div role="status" className="space-y-1">
          <p
            className={`text-sm font-medium ${generateState.ok ? "text-positive" : "text-danger"}`}
          >
            {generateState.message}
          </p>
          {generateState.detail ? (
            <p className="text-ink-soft text-xs">{generateState.detail}</p>
          ) : null}
        </div>
      ) : null}

      {drafts.length > 0 ? (
        <ul className="space-y-3">
          {drafts.map((draft) => (
            <DraftCard key={draft.id} contactId={contactId} draft={draft} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DraftCard({ contactId, draft }: { contactId: string; draft: DraftData }) {
  const [isEditing, setIsEditing] = useState(false);

  const [acceptState, acceptAction, isAccepting] = useActionState(
    async (_previous: ReplyActionResult, formData: FormData) => acceptDraftAction(formData),
    INITIAL,
  );
  const [editState, editAction, isSavingEdit] = useActionState(
    async (_previous: ReplyActionResult, formData: FormData) => {
      const result = await editDraftAction(formData);
      if (result.ok) setIsEditing(false);
      return result;
    },
    INITIAL,
  );
  const [discardState, discardAction, isDiscarding] = useActionState(
    async (_previous: ReplyActionResult, formData: FormData) => discardDraftAction(formData),
    INITIAL,
  );

  const reviewed = draft.status !== "draft";

  return (
    <li className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {draft.tone ? <Badge tone="neutral">{draft.tone}</Badge> : null}
        {draft.status === "accepted" ? <Badge tone="positive">Accepted</Badge> : null}
        {draft.status === "edited" ? <Badge tone="positive">Edited by you</Badge> : null}
        {draft.usedMemoryCount > 0 ? (
          <span className="text-ink-faint text-xs">
            uses {draft.usedMemoryCount} memor{draft.usedMemoryCount === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>

      {draft.status === "edited" && draft.editedBody ? (
        <>
          <p className="text-ink mt-2 text-sm">{draft.editedBody}</p>
          <details className="mt-1">
            <summary className="text-ink-faint cursor-pointer text-xs">Original suggestion</summary>
            <p className="text-ink-soft mt-1 text-xs">{draft.body}</p>
          </details>
        </>
      ) : (
        <p className="text-ink mt-2 text-sm">{draft.body}</p>
      )}

      {!reviewed ? (
        <>
          {isEditing ? (
            <form action={editAction} className="border-border-subtle mt-3 space-y-2 border-t pt-3">
              <input type="hidden" name="contactId" value={contactId} />
              <input type="hidden" name="draftId" value={draft.id} />
              <label htmlFor={`edited-${draft.id}`} className="text-ink block text-xs font-medium">
                Your version
              </label>
              <textarea
                id={`edited-${draft.id}`}
                name="editedBody"
                defaultValue={draft.body}
                rows={3}
                className="border-border-strong bg-surface focus-visible:ring-accent w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={isSavingEdit}
                  className="bg-accent rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {isSavingEdit ? "Saving…" : "Save my version"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-3 py-1.5 text-xs font-medium"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <form action={acceptAction} className="inline">
                <input type="hidden" name="contactId" value={contactId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <button
                  type="submit"
                  disabled={isAccepting}
                  className="text-accent-ink text-xs font-medium hover:underline disabled:opacity-60"
                >
                  {isAccepting ? "Saving…" : "Use as-is"}
                </button>
              </form>

              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-accent-ink text-xs font-medium hover:underline"
              >
                Edit first
              </button>

              <form action={discardAction} className="inline">
                <input type="hidden" name="contactId" value={contactId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <button
                  type="submit"
                  disabled={isDiscarding}
                  className="text-ink-faint hover:text-danger text-xs font-medium hover:underline disabled:opacity-60"
                >
                  {isDiscarding ? "Discarding…" : "Discard"}
                </button>
              </form>
            </div>
          )}
        </>
      ) : (
        <p className="text-ink-faint mt-2 text-xs">
          Copy this into WhatsApp yourself — Moti never sends messages.
        </p>
      )}

      {[acceptState, editState, discardState]
        .filter((state) => state.message.length > 0)
        .map((state, index) => (
          <p
            key={index}
            role="status"
            className={`mt-2 text-xs ${state.ok ? "text-positive" : "text-danger"}`}
          >
            {state.message}
          </p>
        ))}

      {draft.modelProvider ? (
        <p className="text-ink-faint mt-2 text-xs">
          {draft.modelProvider}
          {draft.modelName ? ` · ${draft.modelName}` : ""}
        </p>
      ) : null}
    </li>
  );
}
