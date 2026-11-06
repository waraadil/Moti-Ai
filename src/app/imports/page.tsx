import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ImportForm } from "@/components/imports/import-form";
import { Badge, Card, EmptyState, formatDateTime, PageHeader } from "@/components/ui/primitives";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";
import { listContacts } from "@/server/contacts/repository";
import { listImports } from "@/server/imports/repository";
import type { BadgeTone } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Imports" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

const STATUS_TONES: Record<string, BadgeTone> = {
  uploaded: "neutral",
  parsing: "accent",
  needs_review: "caution",
  completed: "positive",
  failed: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  parsing: "Parsing",
  needs_review: "Needs review",
  completed: "Completed",
  failed: "Failed",
};

export default async function ImportsPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  const [imports, contacts] = await Promise.all([
    listImports(session.supabase, session.userId, { limit: 50 }),
    listContacts(session.supabase, session.userId),
  ]);

  const contactNames = new Map(contacts.map((contact) => [contact.id, contact.display_name]));

  return (
    <AppShell userEmail={session.email}>
      <div className="space-y-6">
        <PageHeader
          title="Imports"
          description="Upload a WhatsApp chat export you created yourself. Files are stored privately under your account and are read only by Moti AI."
        />

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Import a chat export</h2>
          <p className="text-ink-soft mt-1 mb-4 text-sm leading-relaxed">
            In WhatsApp, open the chat → menu → <em>More</em> → <em>Export chat</em> →{" "}
            <em>Without media</em>. Upload the <code className="font-mono text-xs">.txt</code> file
            here. Moti AI does not connect to WhatsApp and cannot read your chats any other way.
          </p>

          {contacts.length === 0 ? (
            <EmptyState
              title="Add a contact first"
              description="An import must belong to a contact so messages stay attached to the right person. Create the contact, then come back."
              action={
                <Link
                  href="/contacts"
                  className="bg-accent rounded-lg px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  Go to contacts
                </Link>
              }
            />
          ) : (
            <ImportForm
              contacts={contacts.map((contact) => ({
                id: contact.id,
                name: contact.display_name,
              }))}
            />
          )}
        </Card>

        <section>
          <h2 className="text-ink mb-3 text-sm font-semibold">Import history</h2>

          {imports.length === 0 ? (
            <EmptyState
              title="No imports yet"
              description="Once you upload an export it appears here with its parse status, participant labels and any lines that could not be read."
            />
          ) : (
            <ul className="space-y-2">
              {imports.map((chatImport) => (
                <Card as="li" key={chatImport.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-ink truncate text-sm font-medium">
                        {chatImport.original_filename}
                      </p>
                      <p className="text-ink-faint mt-0.5 text-xs">
                        {chatImport.contact_id
                          ? (contactNames.get(chatImport.contact_id) ?? "Unknown contact")
                          : "No contact linked"}{" "}
                        · {formatDateTime(chatImport.created_at)} ·{" "}
                        {(chatImport.byte_size / 1024).toFixed(1)} KB
                      </p>
                    </div>
                    <Badge tone={STATUS_TONES[chatImport.status] ?? "neutral"}>
                      {STATUS_LABELS[chatImport.status] ?? chatImport.status}
                    </Badge>
                  </div>

                  <dl className="text-ink-faint mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                    <div>
                      <dt className="inline">Messages: </dt>
                      <dd className="text-ink-soft inline font-medium">
                        {chatImport.parsed_messages.toLocaleString("en-GB")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Lines read: </dt>
                      <dd className="text-ink-soft inline font-medium">
                        {chatImport.total_lines.toLocaleString("en-GB")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Skipped: </dt>
                      <dd className="text-ink-soft inline font-medium">
                        {chatImport.skipped_lines}
                      </dd>
                    </div>
                    {chatImport.detected_participants.length > 0 ? (
                      <div>
                        <dt className="inline">Participants: </dt>
                        <dd className="text-ink-soft inline font-medium">
                          {chatImport.detected_participants.join(", ")}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {chatImport.error_message ? (
                    <p className="text-caution mt-3 rounded-lg border border-[oklch(0.88_0.06_75)] bg-[oklch(0.97_0.03_75)] px-3 py-2 text-xs">
                      {chatImport.error_message}
                    </p>
                  ) : null}
                </Card>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
