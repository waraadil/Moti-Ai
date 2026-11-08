"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/primitives";
import {
  archiveMemoryAction,
  correctMemoryAction,
  type MemoryActionResult,
} from "@/app/contacts/[contactId]/memory-actions";

const INITIAL: MemoryActionResult = { ok: true, message: "" };

const CATEGORY_LABELS: Record<string, string> = {
  preference: "Preference",
  life_event: "Life event",
  relationship: "Relationship",
  boundary: "Boundary",
  goal: "Goal",
  routine: "Routine",
  sensitive: "Sensitive",
};

export type MemoryItemData = {
  id: string;
  category: string;
  statement: string;
  details: string | null;
  confidence: number;
  isSensitive: boolean;
  isUserConfirmed: boolean;
  evidenceCount: number;
};

/**
 * One memory, with the ability to correct or archive it.
 *
 * Correcting opens an inline form rather than editing in place: the action
 * creates a replacement and supersedes this row, so the original wording is
 * never lost.
 */
export function MemoryItem({ contactId, memory }: { contactId: string; memory: MemoryItemData }) {
  const [isEditing, setIsEditing] = useState(false);

  const [correctState, correctAction, isCorrecting] = useActionState(
    async (_previous: MemoryActionResult, formData: FormData) => {
      const result = await correctMemoryAction(formData);
      if (result.ok) setIsEditing(false);
      return result;
    },
    INITIAL,
  );

  const [archiveState, archiveAction, isArchiving] = useActionState(
    async (_previous: MemoryActionResult, formData: FormData) => archiveMemoryAction(formData),
    INITIAL,
  );

  const showArchiveResult = archiveState.message.length > 0 && !archiveState.ok;

  return (
    <li className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{CATEGORY_LABELS[memory.category] ?? memory.category}</Badge>
        {memory.isUserConfirmed ? <Badge tone="positive">You confirmed</Badge> : null}
        {memory.isSensitive ? <Badge tone="caution">Sensitive</Badge> : null}
        <span className="text-ink-faint text-xs">
          confidence {(memory.confidence * 100).toFixed(0)}%
        </span>
        {memory.evidenceCount > 0 ? (
          <span className="text-ink-faint text-xs">
            · {memory.evidenceCount} excerpt{memory.evidenceCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <p className="text-ink mt-2 text-sm">{memory.statement}</p>

      {isEditing ? (
        <form action={correctAction} className="border-border-subtle mt-3 space-y-3 border-t pt-3">
          <input type="hidden" name="contactId" value={contactId} />
          <input type="hidden" name="memoryId" value={memory.id} />

          <div>
            <label
              htmlFor={`statement-${memory.id}`}
              className="text-ink block text-xs font-medium"
            >
              Corrected fact
            </label>
            <textarea
              id={`statement-${memory.id}`}
              name="statement"
              defaultValue={memory.statement}
              rows={2}
              required
              className="border-border-strong bg-surface focus-visible:ring-accent mt-1 w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
            {correctState.fieldErrors?.statement ? (
              <p className="text-danger mt-1 text-xs">{correctState.fieldErrors.statement}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor={`category-${memory.id}`} className="text-ink block text-xs font-medium">
              Category
            </label>
            <select
              id={`category-${memory.id}`}
              name="category"
              defaultValue={memory.category}
              className="border-border-strong bg-surface mt-1 rounded-lg border px-3 py-2 text-sm"
            >
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={isCorrecting}
              className="bg-accent rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {isCorrecting ? "Saving…" : "Save correction"}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-3 py-1.5 text-xs font-medium"
            >
              Cancel
            </button>
          </div>

          {correctState.message.length > 0 ? (
            <p
              role="status"
              className={`text-xs ${correctState.ok ? "text-positive" : "text-danger"}`}
            >
              {correctState.message}
            </p>
          ) : null}
        </form>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setIsEditing((open) => !open)}
          className="text-accent-ink text-xs font-medium hover:underline"
        >
          {isEditing ? "Close editor" : "Correct"}
        </button>

        <form action={archiveAction} className="inline">
          <input type="hidden" name="contactId" value={contactId} />
          <input type="hidden" name="memoryId" value={memory.id} />
          <button
            type="submit"
            disabled={isArchiving}
            className="text-ink-soft hover:text-danger text-xs font-medium hover:underline disabled:opacity-60"
          >
            {isArchiving ? "Archiving…" : "Archive"}
          </button>
        </form>
      </div>

      {showArchiveResult ? (
        <p role="status" className="text-danger mt-1 text-xs">
          {archiveState.message}
        </p>
      ) : null}

      {archiveState.ok && archiveState.message.length > 0 ? (
        <p role="status" className="text-positive mt-1 text-xs">
          {archiveState.message}
        </p>
      ) : null}
    </li>
  );
}
