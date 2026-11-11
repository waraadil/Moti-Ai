"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/primitives";
import {
  decidePreparedReplyAction,
  saveAwaySettingsAction,
  setPermissionAction,
  clearPermissionAction,
  type AwayActionResult,
} from "@/app/away/actions";

const INITIAL: AwayActionResult = { ok: true, message: "" };

/** Converts a stored ISO instant into the value a datetime-local input expects. */
function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function Feedback({ state }: { state: AwayActionResult }) {
  if (!state.message) return null;
  return (
    <p
      className={`text-xs ${state.ok ? "text-ink-soft" : "text-danger"}`}
      role={state.ok ? "status" : "alert"}
    >
      {state.message}
      {state.detail ? ` ${state.detail}` : null}
    </p>
  );
}

export type AwaySettingsData = {
  status: "active" | "scheduled" | "off";
  startsAt: string | null;
  endsAt: string | null;
  awayMessage: string | null;
  defaultPermission: "draft_only" | "silent";
};

export function AwaySettingsForm({ settings }: { settings: AwaySettingsData }) {
  const [state, action, isPending] = useActionState(
    async (_previous: AwayActionResult, formData: FormData) => saveAwaySettingsAction(formData),
    INITIAL,
  );

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="status" className="text-ink text-sm font-medium">
          Away Mode
        </label>
        <select
          id="status"
          name="status"
          defaultValue={settings.status}
          className="border-border-strong bg-surface text-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        >
          <option value="off">Off — prepare nothing</option>
          <option value="active">On now</option>
          <option value="scheduled">Scheduled for later</option>
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="startsAt" className="text-ink text-sm font-medium">
            Starts
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            defaultValue={toLocalInput(settings.startsAt)}
            className="border-border-strong bg-surface text-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
          <p className="text-ink-faint mt-1 text-xs">Leave empty to start immediately.</p>
        </div>
        <div>
          <label htmlFor="endsAt" className="text-ink text-sm font-medium">
            Ends
          </label>
          <input
            id="endsAt"
            name="endsAt"
            type="datetime-local"
            defaultValue={toLocalInput(settings.endsAt)}
            className="border-border-strong bg-surface text-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
          <p className="text-ink-faint mt-1 text-xs">Leave empty to stay on until you turn it off.</p>
        </div>
      </div>

      <div>
        <label htmlFor="awayMessage" className="text-ink text-sm font-medium">
          Away message (optional)
        </label>
        <textarea
          id="awayMessage"
          name="awayMessage"
          rows={2}
          maxLength={280}
          defaultValue={settings.awayMessage ?? ""}
          placeholder="Travelling today, will reply when I can."
          className="border-border-strong bg-surface text-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        />
        <p className="text-ink-faint mt-1 text-xs">
          Shown to you when reviewing a prepared reply. It is never sent on its own.
        </p>
      </div>

      <div>
        <label htmlFor="defaultPermission" className="text-ink text-sm font-medium">
          Contacts without their own rule
        </label>
        <select
          id="defaultPermission"
          name="defaultPermission"
          defaultValue={settings.defaultPermission}
          className="border-border-strong bg-surface text-ink mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        >
          <option value="draft_only">Prepare drafts for me to review</option>
          <option value="silent">Prepare nothing</option>
        </select>
      </div>

      <Feedback state={state} />

      <button
        type="submit"
        disabled={isPending}
        className="bg-accent text-accent-ink rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {isPending ? "Saving…" : "Save Away Mode"}
      </button>
    </form>
  );
}

export function ContactPermissionControl({
  contactId,
  contactName,
  permission,
}: {
  contactId: string;
  contactName: string;
  permission: "draft_only" | "silent" | null;
}) {
  const [state, action, isPending] = useActionState(
    async (_previous: AwayActionResult, formData: FormData) => {
      if (formData.get("intent") === "clear") return clearPermissionAction(formData);
      return setPermissionAction(formData);
    },
    INITIAL,
  );

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="contactId" value={contactId} />
      <span className="text-ink text-sm">{contactName}</span>
      <Badge tone={permission === "silent" ? "caution" : "neutral"}>
        {permission === null ? "default" : permission === "silent" ? "silent" : "drafts"}
      </Badge>

      <button
        type="submit"
        name="permission"
        value="draft_only"
        disabled={isPending}
        className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
      >
        Allow drafts
      </button>
      <button
        type="submit"
        name="permission"
        value="silent"
        disabled={isPending}
        className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
      >
        Silent
      </button>
      {permission !== null ? (
        <button
          type="submit"
          name="intent"
          value="clear"
          disabled={isPending}
          className="text-ink-faint hover:text-ink text-xs underline disabled:opacity-60"
        >
          use default
        </button>
      ) : null}

      <Feedback state={state} />
    </form>
  );
}

export function PreparedReplyActions({ replyId }: { replyId: string }) {
  const [state, action, isPending] = useActionState(
    async (_previous: AwayActionResult, formData: FormData) => decidePreparedReplyAction(formData),
    INITIAL,
  );

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="replyId" value={replyId} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="decision"
          value="approved"
          disabled={isPending}
          className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
        >
          Accept
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={isPending}
          className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-2 py-1 text-xs disabled:opacity-60"
        >
          Discard
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
