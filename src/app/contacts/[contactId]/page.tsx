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
import { listImports } from "@/server/imports/repository";
import { AnalyseButton } from "@/components/contacts/analyse-button";
import { loadContactAnalysisView, loadMemories, previewEvidence } from "@/server/analysis/view";

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

  const [stats, memories, recentMessages, imports, analysis, evidence] = await Promise.all([
    getConversationStats(session.supabase, session.userId, contactId),
    loadMemories(session.supabase, session.userId, contactId),
    listMessages(session.supabase, session.userId, contactId, {
      limit: 15,
      offset: 0,
    }),
    listImports(session.supabase, session.userId, { contactId, limit: 5 }),
    loadContactAnalysisView(session.supabase, session.userId, contactId, contact.display_name),
    previewEvidence(session.supabase, session.userId, contactId, contact.display_name),
  ]);

  const hasAnalysis = analysis.latestVersion !== null;

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
                {hasAnalysis ? (
                  <Badge tone="positive">Version {analysis.latestVersion?.version}</Badge>
                ) : (
                  <Badge tone="neutral">Not analysed</Badge>
                )}
              </div>
              <p className="text-ink-soft mt-2 text-sm leading-relaxed">
                Moti AI builds one profile for you and one for {contact.display_name} from the same
                conversation, so tone and rhythm can be compared rather than blended.
              </p>

              {hasAnalysis ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                    <p className="text-ink-faint text-xs font-medium uppercase">You</p>
                    <p className="text-ink mt-1 text-sm leading-relaxed">
                      {analysis.selfProfile?.summary || "No summary produced."}
                    </p>
                    <p className="text-ink-faint mt-2 text-xs">
                      {analysis.selfProfile?.messageCount.toLocaleString("en-GB")} messages ·
                      confidence {Math.round((analysis.selfProfile?.confidence ?? 0) * 100)}% (
                      {analysis.selfProfile?.level})
                    </p>
                  </div>
                  <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                    <p className="text-ink-faint text-xs font-medium uppercase">
                      {contact.display_name}
                    </p>
                    <p className="text-ink mt-1 text-sm leading-relaxed">
                      {analysis.contactProfile?.summary || "No summary produced."}
                    </p>
                    <p className="text-ink-faint mt-2 text-xs">
                      {analysis.contactProfile?.messageCount.toLocaleString("en-GB")} messages ·
                      confidence {Math.round((analysis.contactProfile?.confidence ?? 0) * 100)}% (
                      {analysis.contactProfile?.level})
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                    <p className="text-ink-faint text-xs font-medium uppercase">You</p>
                    <NotAnalysed label={`${evidence.selfMessages ?? 0} messages available`} />
                  </div>
                  <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
                    <p className="text-ink-faint text-xs font-medium uppercase">
                      {contact.display_name}
                    </p>
                    <NotAnalysed label={`${evidence.contactMessages ?? 0} messages available`} />
                  </div>
                </div>
              )}

              <div className="border-border-subtle mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-ink-faint text-xs">
                  Engine: {analysis.providerLabel}
                  {hasAnalysis
                    ? ` · ${analysis.messageCount.toLocaleString("en-GB")} messages analysed`
                    : ""}
                </p>
                <AnalyseButton contactId={contact.id} disabled={stats.totalMessages === 0} />
              </div>
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
                Recurring topics, plans and threads taken from the conversation itself.
              </p>

              {hasAnalysis && analysis.topics.length > 0 ? (
                <div className="border-border-subtle bg-surface mt-3 rounded-lg border px-4 py-3">
                  <p className="text-ink-faint text-xs font-medium uppercase">Topics</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {analysis.topics.map((topic) => (
                      <Badge key={topic.label} tone="neutral">
                        {topic.label} · {topic.mentions}
                      </Badge>
                    ))}
                  </div>

                  {analysis.plans.length > 0 ? (
                    <div className="mt-4">
                      <p className="text-ink-faint text-xs font-medium uppercase">Plans</p>
                      <ul className="mt-1.5 space-y-1">
                        {analysis.plans.slice(0, 5).map((plan) => (
                          <li
                            key={`${plan.description}-${plan.status}`}
                            className="text-ink-soft text-xs"
                          >
                            <span className="text-ink">&ldquo;{plan.description}&rdquo;</span> —{" "}
                            {plan.status} · {plan.evidenceCount} citation
                            {plan.evidenceCount === 1 ? "" : "s"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {analysis.openThreads.length > 0 ? (
                    <div className="mt-4">
                      <p className="text-ink-faint text-xs font-medium uppercase">Open threads</p>
                      <ul className="mt-1.5 space-y-1">
                        {analysis.openThreads.slice(0, 5).map((thread) => (
                          <li key={thread.topic} className="text-ink-soft text-xs">
                            <span className="text-ink capitalize">{thread.topic}</span> —{" "}
                            {thread.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="border-border-subtle bg-surface mt-3 rounded-lg border px-4 py-3">
                  <NotAnalysed
                    label={
                      hasAnalysis
                        ? "No recurring topics found in this conversation"
                        : "No context recorded yet"
                    }
                  />
                </div>
              )}
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
                {hasAnalysis
                  ? "Draft generation uses the profiles and memories above and refuses to invent promises, feelings or commitments. Drafts are saved for review and are never sent from Moti AI."
                  : "Requires a completed analysis run."}
              </p>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
