import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Badge, Card, EmptyState, formatDateTime, PageHeader } from "@/components/ui/primitives";
import { AWAY_DISCLOSURE } from "@/lib/intelligence/away";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";
import { listContacts } from "@/server/contacts/repository";
import { listContactPermissions, listPendingReplies } from "@/server/away/repository";
import { loadAwayActivity, loadAwayOverview } from "@/server/away/service";
import {
  AwaySettingsForm,
  ContactPermissionControl,
  PreparedReplyActions,
} from "@/components/away/away-controls";

export const metadata: Metadata = { title: "Away Mode" };

// Always rendered per request: depends on the current session and the clock.
export const dynamic = "force-dynamic";

export default async function AwayPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  const { supabase, userId, email } = session;

  const [overview, pending, contacts, permissions, activity] = await Promise.all([
    loadAwayOverview(supabase, userId),
    listPendingReplies(supabase, userId),
    listContacts(supabase, userId),
    listContactPermissions(supabase, userId),
    loadAwayActivity(supabase, userId),
  ]);

  const contactNames = new Map(contacts.map((contact) => [contact.id, contact.display_name]));

  return (
    <AppShell userEmail={email}>
      <div className="space-y-6">
        <PageHeader
          title="Away Mode"
          description="Decide when Moti may prepare replies while you are unavailable, and for whom."
        />

        {/* The limitation is stated before anything else on the page. */}
        <Card as="section" className="border-accent-muted bg-accent-subtle">
          <h2 className="text-ink text-sm font-semibold">Moti cannot send messages</h2>
          <p className="text-ink-soft mt-2 text-sm">
            This is not a limit you can turn off. Away Mode prepares a reply for you to review and
            send yourself; it never contacts anyone on your behalf, and there is no automatic reply
            setting anywhere in this app.
          </p>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Badge
            tone={
              overview.state.effective === "active"
                ? "positive"
                : overview.state.effective === "scheduled"
                  ? "caution"
                  : "neutral"
            }
          >
            {overview.state.effective === "active"
              ? "Away now"
              : overview.state.effective === "scheduled"
                ? "Scheduled"
                : "Off"}
          </Badge>
          <span className="text-ink-soft text-sm">{overview.summary}</span>
        </div>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Settings</h2>
          <div className="mt-4">
            <AwaySettingsForm
              settings={{
                status: overview.settings.status,
                startsAt: overview.settings.starts_at,
                endsAt: overview.settings.ends_at,
                awayMessage: overview.settings.away_message,
                defaultPermission: overview.settings.default_permission,
              }}
            />
          </div>
        </Card>

        <Card as="section">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-ink text-sm font-semibold">Waiting for you</h2>
            <span className="text-ink-faint text-xs">
              {pending.length} prepared {pending.length === 1 ? "reply" : "replies"}
            </span>
          </div>

          <p className="text-ink-faint mt-1 text-xs">{AWAY_DISCLOSURE}</p>

          {pending.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title="Nothing waiting"
                description="When Away Mode is on and a contact writes, any prepared reply appears here for your decision."
              />
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {pending.map((reply) => (
                <li key={reply.id} className="border-border rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">
                      {contactNames.get(reply.contact_id) ?? "Unknown contact"}
                    </Badge>
                    <span className="text-ink-faint text-xs">
                      prepared {formatDateTime(reply.created_at)}
                    </span>
                  </div>
                  <p className="text-ink mt-2 text-sm whitespace-pre-wrap">{reply.body}</p>
                  <div className="mt-3">
                    <PreparedReplyActions replyId={reply.id} />
                  </div>
                  <Link
                    href={`/contacts/${reply.contact_id}`}
                    className="text-ink-faint hover:text-ink mt-2 inline-block text-xs underline"
                  >
                    Open the conversation
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Per-contact rules</h2>
          <p className="text-ink-soft mt-1 text-sm">
            Override your default for individual people. &ldquo;Silent&rdquo; means nothing is
            prepared for them at all.
          </p>

          {contacts.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title="No contacts yet"
                description="Import a conversation first, then choose who Away Mode may cover."
              />
            </div>
          ) : (
            <ul className="mt-4 divide-y space-y-2">
              {contacts.map((contact) => (
                <li key={contact.id} className="pt-2 first:pt-0">
                  <ContactPermissionControl
                    contactId={contact.id}
                    contactName={contact.display_name}
                    permission={permissions.get(contact.id)?.permission ?? null}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Activity</h2>
          <p className="text-ink-soft mt-1 text-sm">
            An append-only record. Entries cannot be edited or deleted.
          </p>

          {activity.length === 0 ? (
            <div className="mt-3">
              <EmptyState
                title="No activity yet"
                description="Enabling Away Mode and deciding on prepared replies will be recorded here."
              />
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {activity.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Badge tone="neutral">{event.kind.replace(/_/g, " ")}</Badge>
                  <span className="text-ink-soft">{event.detail ?? "—"}</span>
                  <span className="text-ink-faint text-xs">{formatDateTime(event.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
