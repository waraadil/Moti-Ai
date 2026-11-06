import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import {
  Badge,
  Card,
  EmptyState,
  formatDateTime,
  NotAnalysed,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";
import { getContact } from "@/server/contacts/repository";
import { getConversationStats, listMessages } from "@/server/messages/repository";
import { listMemoriesWithEvidence } from "@/server/memories/repository";
import { listImports } from "@/server/imports/repository";

export const metadata: Metadata = { title: "Contact" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<string, string> = {
  preference: "Preference",
  life_event: "Life event",
  relationship: "Relationship",
  boundary: "Boundary",
  goal: "Goal",
  routine: "Routine",
  sensitive: "Sensitive",
};

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  const { contactId } = await params;
  const contact = await getContact(session.supabase, session.userId, contactId);
  if (!contact) notFound();

  const [stats, memories, recentMessages, imports] = await Promise.all([
    getConversationStats(session.supabase, session.userId, contactId),
    listMemoriesWithEvidence(session.supabase, session.userId, contactId, { limit: 20 }),
    listMessages(session.supabase, session.userId, contactId, {
      limit: 15,
      offset: 0,
    }),
    listImports(session.supabase, session.userId, { contactId, limit: 5 }),
  ]);

  return (
    <AppShell userEmail={session.email}>
      <div className="space-y-6">
        <PageHeader
          title={contact.display_name}
          description={
            contact.notes ??
            "Everything Moti AI knows about this person, and where that knowledge came from."
          }
          actions={
            <Link
              href="/contacts"
              className="border-border-strong text-ink-soft hover:bg-surface-sunken rounded-lg border px-3 py-1.5 text-sm font-medium"
            >
              All contacts
            </Link>
          }
        />

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Messages" value={stats.totalMessages.toLocaleString("en-GB")} />
          <Stat
            label="Incoming / outgoing"
            value={`${stats.incoming.toLocaleString("en-GB")} / ${stats.outgoing.toLocaleString("en-GB")}`}
          />
          <Stat label="First message" value={formatDateTime(stats.firstMessageAt)} />
          <Stat label="Latest message" value={formatDateTime(stats.lastMessageAt)} />
        </dl>

        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            {/* Communication profiles */}
            <Card as="section">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-ink text-sm font-semibold">Communication profiles</h2>
                <Badge tone="neutral">Not generated</Badge>
              </div>
              <p className="text-ink-soft mt-2 text-sm leading-relaxed">
                Moti AI builds one profile for you and one for {contact.display_name} from the same
                conversation, so tone and rhythm can be compared rather than blended.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                  <p className="text-ink-faint text-xs font-medium uppercase">You</p>
                  <NotAnalysed />
                </div>
                <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                  <p className="text-ink-faint text-xs font-medium uppercase">
                    {contact.display_name}
                  </p>
                  <NotAnalysed />
                </div>
              </div>
              <p className="text-ink-faint mt-3 text-xs">
                Profiles require an analysis run. This build ships the schema and data access; the
                analysis pipeline is the next milestone.
              </p>
            </Card>

            {/* Memories */}
            <Card as="section">
              <h2 className="text-ink text-sm font-semibold">Memories</h2>
              <p className="text-ink-soft mt-1 text-sm">
                Facts about {contact.display_name} that Moti AI can cite, each linked to the
                messages that support it.
              </p>

              {memories.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="No memories recorded"
                    description="Memories appear after an import has been analysed. You can also add one manually — it will be marked as confirmed by you."
                  />
                </div>
              ) : (
                <ul className="mt-4 space-y-3">
                  {memories.map((memory) => (
                    <li
                      key={memory.id}
                      className="border-border-subtle bg-surface rounded-lg border px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="accent">
                          {CATEGORY_LABELS[memory.category] ?? memory.category}
                        </Badge>
                        {memory.is_user_confirmed ? (
                          <Badge tone="positive">You confirmed</Badge>
                        ) : null}
                        {memory.is_sensitive ? <Badge tone="caution">Sensitive</Badge> : null}
                        <span className="text-ink-faint text-xs">
                          confidence {(memory.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-ink mt-2 text-sm">{memory.statement}</p>
                      {memory.evidence.length > 0 ? (
                        <details className="mt-2">
                          <summary className="text-accent-ink cursor-pointer text-xs font-medium">
                            {memory.evidence.length} supporting excerpt
                            {memory.evidence.length === 1 ? "" : "s"}
                          </summary>
                          <ul className="border-border-subtle mt-2 space-y-1.5 border-l-2 pl-3">
                            {memory.evidence.map((item) => (
                              <li key={item.id} className="text-ink-soft text-xs">
                                {item.excerpt ?? "(message excerpt unavailable)"}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <p className="text-ink-faint mt-2 text-xs">No evidence attached yet.</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Conversation */}
            <Card as="section">
              <h2 className="text-ink text-sm font-semibold">Recent messages</h2>
              {recentMessages.messages.length === 0 ? (
                <p className="text-ink-soft mt-2 text-sm">
                  No messages imported for this contact yet.{" "}
                  <Link href="/imports" className="text-accent-ink font-medium hover:underline">
                    Import an export
                  </Link>
                  .
                </p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {recentMessages.messages.map((message) => (
                    <li key={message.id} className="flex gap-3 text-sm">
                      <span className="text-ink-faint w-24 shrink-0 text-xs">
                        {formatDateTime(message.sent_at)}
                      </span>
                      <span
                        className={
                          message.direction === "outgoing"
                            ? "text-ink-soft min-w-0"
                            : "text-ink min-w-0"
                        }
                      >
                        {message.body ?? (
                          <span className="text-ink-faint italic">
                            {message.kind === "media"
                              ? `[${message.media_filename ?? "media"}]`
                              : `[${message.kind.replace("_", " ")}]`}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-6 lg:col-span-2">
            <Card as="section">
              <h2 className="text-ink text-sm font-semibold">Relationship context</h2>
              <p className="text-ink-soft mt-2 text-sm">
                How you know each other, current dynamics and open threads.
              </p>
              <div className="border-border-subtle bg-surface mt-3 rounded-lg border px-4 py-3">
                <NotAnalysed label="No context recorded yet" />
              </div>
            </Card>

            <Card as="section">
              <h2 className="text-ink text-sm font-semibold">Imports</h2>
              {imports.length === 0 ? (
                <p className="text-ink-soft mt-2 text-sm">Nothing imported for this contact yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {imports.map((chatImport) => (
                    <li
                      key={chatImport.id}
                      className="border-border-subtle bg-surface rounded-lg border px-3 py-2"
                    >
                      <p className="text-ink truncate text-xs font-medium">
                        {chatImport.original_filename}
                      </p>
                      <p className="text-ink-faint mt-0.5 text-xs">
                        {chatImport.parsed_messages.toLocaleString("en-GB")} messages ·{" "}
                        {chatImport.status.replace("_", " ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card as="section">
              <h2 className="text-ink text-sm font-semibold">Reply suggestions</h2>
              <p className="text-ink-soft mt-2 text-sm">
                Draft replies are generated from the profile and memories above. Nothing is ever
                sent automatically.
              </p>
              <p className="text-ink-faint mt-3 text-xs">
                Requires a completed analysis run. Not available in this build.
              </p>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
