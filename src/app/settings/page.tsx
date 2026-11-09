import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Badge, Card, formatDateTime, PageHeader, Stat } from "@/components/ui/primitives";
import { isPublicEnvConfigured } from "@/lib/env";
import { isServiceRoleConfigured } from "@/lib/supabase/admin";
import { getOptionalSession } from "@/server/auth/session";
import { listContacts } from "@/server/contacts/repository";
import { DeleteContactForm, DeleteEverythingForm } from "@/components/settings/data-controls";

export const metadata: Metadata = { title: "Settings" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  // Report what is genuinely configured, from the server, without exposing keys.
  const adminConfigured = isServiceRoleConfigured();

  const contacts = await listContacts(session.supabase, session.userId);

  return (
    <AppShell userEmail={session.email}>
      <div className="space-y-6">
        <PageHeader
          title="Settings"
          description="Your account, what Moti AI can access, and the state of this deployment."
        />

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Name</dt>
              <dd className="text-ink font-medium">{session.profile?.display_name ?? "Not set"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Email</dt>
              <dd className="text-ink truncate font-medium">{session.email ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Member since</dt>
              <dd className="text-ink font-medium">
                {formatDateTime(session.profile?.created_at ?? null)}
              </dd>
            </div>
          </dl>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Configuration status</h2>
          <p className="text-ink-soft mt-1 text-sm">
            Checked on the server. Secrets are never sent to the browser.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            <li className="flex items-center justify-between gap-4">
              <span className="text-ink-soft">Supabase project (auth + database)</span>
              <Badge tone="positive">Configured</Badge>
            </li>
            <li className="flex items-center justify-between gap-4">
              <span className="text-ink-soft">Private storage buckets</span>
              <Badge tone="positive">Configured</Badge>
            </li>
            <li className="flex items-center justify-between gap-4">
              <span className="text-ink-soft">
                Service role key{" "}
                <span className="text-ink-faint block text-xs">
                  Needed for background jobs only. The app runs without it.
                </span>
              </span>
              <Badge tone={adminConfigured ? "positive" : "neutral"}>
                {adminConfigured ? "Configured" : "Not set"}
              </Badge>
            </li>
            <li className="flex items-center justify-between gap-4">
              <span className="text-ink-soft">
                AI model provider
                <span className="text-ink-faint block text-xs">
                  Required for profiles, memories and reply drafts.
                </span>
              </span>
              <Badge tone="neutral">Not configured</Badge>
            </li>
            <li className="flex items-center justify-between gap-4">
              <span className="text-ink-soft">WhatsApp integration</span>
              <Badge tone="neutral">Not supported by design</Badge>
            </li>
          </ul>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Data handling</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Row isolation" value="Per user" hint="Row Level Security" />
            <Stat label="Export files" value="Private" hint="Signed URLs only" />
            <Stat label="Message history" value="Immutable" hint="Append-only" />
            <Stat label="Auto-send" value="Never" hint="Drafts only" />
          </dl>
          <p className="text-ink-faint mt-4 text-xs leading-relaxed">
            Archived contacts and superseded memories are retained rather than deleted while the
            account is in use, so past analysis stays auditable. You can remove any of it at any
            time below.
          </p>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Download your data</h2>
          <p className="text-ink-soft mt-2 text-sm">
            A single JSON file containing every contact, message, import record, memory, analysis
            version, reply draft and Away Mode entry you own. It contains no passwords and no data
            belonging to anyone else.
          </p>
          <a
            href="/api/export"
            className="border-border-strong text-ink-soft hover:bg-surface-sunken mt-3 inline-block rounded-lg border px-3 py-2 text-sm font-medium"
          >
            Download my data (JSON)
          </a>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Delete a conversation</h2>
          <p className="text-ink-soft mt-1 text-sm">
            Removes one contact, its messages, the stored export files, its analysis and any
            prepared replies. Permanent.
          </p>
          {contacts.length === 0 ? (
            <p className="text-ink-faint mt-3 text-sm">You have no contacts to delete.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {contacts.map((contact) => (
                <DeleteContactForm
                  key={contact.id}
                  contactId={contact.id}
                  contactName={contact.display_name}
                />
              ))}
            </div>
          )}
        </Card>

        <Card as="section" className="border-danger/40">
          <h2 className="text-ink text-sm font-semibold">Delete all my data</h2>
          <div className="mt-2">
            <DeleteEverythingForm />
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
