import type { ReactNode } from "react";

/**
 * Small presentational primitives.
 *
 * No client-side behaviour lives here, so these stay usable from Server
 * Components. Class names reference the tokens defined in globals.css.
 */

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
  as: Component = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Component
      className={cx(
        "border-border-subtle bg-surface-raised rounded-xl border p-5 shadow-[0_1px_2px_oklch(0_0_0/0.04)]",
        className,
      )}
    >
      {children}
    </Component>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="border-border-subtle flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-ink text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-ink-soft mt-1.5 max-w-2xl text-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

const BADGE_TONES = {
  neutral: "bg-surface-sunken text-ink-soft border-border-subtle",
  accent: "bg-accent-soft text-accent-ink border-accent/30",
  positive: "bg-[oklch(0.96_0.03_155)] text-positive border-[oklch(0.86_0.06_155)]",
  caution: "bg-[oklch(0.97_0.03_75)] text-caution border-[oklch(0.88_0.06_75)]",
  danger: "bg-[oklch(0.96_0.03_25)] text-danger border-[oklch(0.87_0.06_25)]",
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border-strong bg-surface-sunken rounded-xl border border-dashed px-6 py-12 text-center">
      <h2 className="text-ink text-sm font-semibold">{title}</h2>
      <p className="text-ink-soft mx-auto mt-2 max-w-md text-sm leading-relaxed">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * Renders a value that Moti AI has not computed yet.
 * Explicitly distinguishes "not analysed" from "analysed, found nothing".
 */
export function NotAnalysed({ label = "Not analysed yet" }: { label?: string }) {
  return <span className="text-ink-faint text-xs italic">{label}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="border-border-subtle bg-surface rounded-lg border px-4 py-3">
      <dt className="text-ink-faint text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className="text-ink mt-1 text-lg font-semibold">{value}</dd>
      {hint ? <p className="text-ink-faint mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
