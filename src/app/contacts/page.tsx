import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ContactForm } from "@/components/contacts/contact-form";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";
import { getContactCounts, listContacts } from "@/server/contacts/repository";

export const metadata: Metadata = { title: "Contacts" };

// Always rendered per request: this page depends on the current session.
export const dynamic = "force-dynamic";

const RELATIONSHIP_LABELS: Record<string, string> = {
  family: "Family",
  friend: "Friend",
  partner: "Partner",
  colleague: "Colleague",
  acquaintance: "Acquaintance",
  client: "Client",
  other: "Other",
  unknown: "Unclassified",
};

export default async function ContactsPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  const contacts = await listContacts(session.supabase, session.userId);
  const counts = await getContactCounts(
    session.supabase,
    session.userId,
    contacts.map((contact) => contact.id),
  );

  return (
    <AppShell userEmail={session.email}>
      <div className="space-y-6">
        <PageHeader
          title="Contacts"
          description="Each person you analyse gets their own communication profile, relationship context and memory trail."
        />

        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            description="Add the person whose conversation you want to understand. Use the same name that appears in your exported chat so imports match cleanly."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {contacts.map((contact) => {
              const contactCounts = counts.get(contact.id);
              return (
                <Card as="li" key={contact.id} className="flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-ink truncate text-sm font-semibold">
                        <Link
                          href={`/contacts/${contact.id}`}
                          className="hover:text-accent-ink hover:underline"
                        >
                          {contact.display_name}
                        </Link>
                      </h2>
                      <Badge>
                        {RELATIONSHIP_LABELS[contact.relationship_kind] ?? "Unclassified"}
                      </Badge>
                    </div>
                    {contact.notes ? (
                      <p className="text-ink-soft mt-2 line-clamp-2 text-xs leading-relaxed">
                        {contact.notes}
                      </p>
                    ) : null}
                  </div>

                  <dl className="text-ink-faint mt-4 flex gap-5 text-xs">
                    <div>
                      <dt className="inline">Imports: </dt>
                      <dd className="text-ink-soft inline font-medium">
                        {contactCounts?.importCount ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Memories: </dt>
                      <dd className="text-ink-soft inline font-medium">
                        {contactCounts?.activeMemoryCount ?? 0}
                      </dd>
                    </div>
                  </dl>
                </Card>
              );
            })}
          </ul>
        )}

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Add a contact</h2>
          <p className="text-ink-soft mt-1 mb-4 text-sm">
            Moti AI never merges two contacts automatically. If the same person appears under
            different names, add them separately and link them later.
          </p>
          <ContactForm />
        </Card>
      </div>
    </AppShell>
  );
}
