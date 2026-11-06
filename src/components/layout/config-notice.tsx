import { Card } from "@/components/ui/primitives";

/**
 * Shown when Supabase credentials are missing.
 *
 * This is the honest state for a fresh clone: the app runs and renders, but
 * authentication and data features report that they are not configured rather
 * than pretending to work.
 */
export function ConfigNotice() {
  return (
    <Card className="border-caution/40 bg-[oklch(0.97_0.03_75)]/60">
      <h2 className="text-ink text-sm font-semibold">Supabase is not configured</h2>
      <p className="text-ink-soft mt-1.5 text-sm leading-relaxed">
        Accounts, contacts and imports need a Supabase project. Create{" "}
        <code className="bg-surface-raised rounded px-1 py-0.5 font-mono text-xs">.env.local</code>{" "}
        from{" "}
        <code className="bg-surface-raised rounded px-1 py-0.5 font-mono text-xs">
          .env.example
        </code>{" "}
        and set <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, then restart the
        dev server. Run the SQL in{" "}
        <code className="bg-surface-raised rounded px-1 py-0.5 font-mono text-xs">
          supabase/migrations
        </code>{" "}
        against your project first.
      </p>
    </Card>
  );
}
