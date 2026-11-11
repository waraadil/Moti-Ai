import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { isPublicEnvConfigured } from "@/lib/env";
import { getOptionalSession } from "@/server/auth/session";
import { loadPlatformStatus } from "@/server/platform/readiness";
import {
  OFFERED_PATHS,
  sendCapability,
  UNOFFICIAL_CLIENT_STANCE,
} from "@/lib/platform/capabilities";

export const metadata: Metadata = { title: "Integrations" };

// Depends on server configuration, so never prerendered.
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  if (!isPublicEnvConfigured()) redirect("/login");

  const session = await getOptionalSession();
  if (!session) redirect("/login");

  const status = loadPlatformStatus();
  const send = sendCapability();
  const platform = status.platform;

  return (
    <AppShell userEmail={session.email}>
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="What Moti AI can connect to, what it cannot, and what each path would require."
        />

        {/* The headline is the limitation, not the feature. */}
        <Card as="section" className="border-accent-muted bg-accent-subtle">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-ink text-sm font-semibold">{platform.name}</h2>
            <Badge tone="caution">Export only</Badge>
          </div>
          <p className="text-ink-soft mt-2 text-sm">{platform.currentState}</p>
          <p className="text-ink-soft mt-2 text-sm">
            <strong className="text-ink">Sending:</strong> {send.reason}
          </p>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Ways to connect</h2>
          <ul className="mt-3 space-y-3">
            {OFFERED_PATHS.map((option) => {
              const available = option.path === "export_file";
              return (
                <li key={option.path} className="border-border rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink text-sm font-medium">{option.label}</span>
                    <Badge tone={available ? "positive" : "neutral"}>
                      {available ? "Available now" : "Not connected"}
                    </Badge>
                  </div>
                  <p className="text-ink-soft mt-1 text-sm">{option.description}</p>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Readiness for the official API</h2>
          <p className="text-ink-soft mt-1 text-sm">{status.summary}</p>
          <p className="text-ink-faint mt-1 text-xs">
            Configured credentials are reported as present or absent only. Nothing here tests a
            network connection, because a connection cannot succeed while the code to use it does
            not exist.
          </p>

          <ul className="mt-4 divide-y">
            {status.report.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-2 py-2 first:pt-0">
                <Badge
                  tone={
                    item.status === "ready"
                      ? "positive"
                      : item.status === "missing"
                        ? "caution"
                        : "neutral"
                  }
                >
                  {item.status === "ready"
                    ? "in place"
                    : item.status === "missing"
                      ? "missing"
                      : "not implemented"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-ink text-sm font-medium">{item.label}</p>
                  <p className="text-ink-soft text-xs">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">What an official connection requires</h2>
          <ul className="text-ink-soft mt-2 list-disc space-y-1 pl-5 text-sm">
            {platform.requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        </Card>

        <Card as="section">
          <h2 className="text-ink text-sm font-semibold">Limits you would live with</h2>
          <p className="text-ink-soft mt-1 text-sm">
            These are the platform&rsquo;s rules, not Moti&rsquo;s. They are listed so the decision is
            an informed one.
          </p>
          <ul className="text-ink-soft mt-2 list-disc space-y-1 pl-5 text-sm">
            {platform.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </Card>

        <Card as="section" className="border-danger/40">
          <h2 className="text-ink text-sm font-semibold">What Moti will not do</h2>
          <p className="text-ink-soft mt-2 text-sm">
            {UNOFFICIAL_CLIENT_STANCE.reason}
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
