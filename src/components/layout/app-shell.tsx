import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";

/**
 * Responsive application shell.
 *
 * Mobile: a single column with a compact top bar and a bottom tab bar.
 * Desktop: a persistent left sidebar.
 *
 * Only routes that exist are linked, so nothing here is a dead button.
 */

type NavItem = {
  href: string;
  label: string;
  description: string;
  /** Inline SVG path data for a 20x20 viewBox. */
  iconPath: string;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: "/contacts",
    label: "Contacts",
    description: "People you talk to",
    iconPath: "M10 9a3 3 0 100-6 3 3 0 000 6zm-6 9a6 6 0 1112 0M17 8a2.5 2.5 0 110 5",
  },
  {
    href: "/imports",
    label: "Imports",
    description: "WhatsApp exports you've added",
    iconPath:
      "M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 15v1.5A1.5 1.5 0 005.5 18h9a1.5 1.5 0 001.5-1.5V15",
  },
  {
    href: "/away",
    label: "Away Mode",
    description: "Prepare replies while you're unavailable",
    iconPath:
      "M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15zm0 3a4.5 4.5 0 100 9 4.5 4.5 0 000-9z",
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Account and data controls",
    iconPath:
      "M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm6.4-2.5c0 .4 0 .8-.1 1.1l1.7 1.3-1.5 2.6-2-.8a6.5 6.5 0 01-1.9 1.1l-.3 2.2h-3l-.3-2.2a6.5 6.5 0 01-1.9-1.1l-2 .8L2 11.4l1.7-1.3a6 6 0 010-2.2L2 6.6l1.5-2.6 2 .8a6.5 6.5 0 011.9-1.1L7.7 1.5h3l.3 2.2a6.5 6.5 0 011.9 1.1l2-.8L18.4 6.6l-1.7 1.3c.1.3.1.7.1 1.1z",
  },
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

export function AppShell({
  children,
  userEmail,
}: {
  children: ReactNode;
  userEmail: string | null;
}) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      {/* Sidebar (desktop) */}
      <aside className="border-border-subtle bg-surface-sunken hidden w-64 shrink-0 border-r lg:flex lg:flex-col">
        <div className="border-border-subtle flex h-16 items-center gap-2 border-b px-5">
          <MotiMark />
          <span className="text-sm font-semibold tracking-tight">Moti AI</span>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="group text-ink-soft hover:bg-surface-raised hover:text-ink flex items-start gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors"
                >
                  <span className="text-ink-faint group-hover:text-accent mt-0.5">
                    <NavIcon path={item.iconPath} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{item.label}</span>
                    <span className="text-ink-faint mt-0.5 block truncate text-xs">
                      {item.description}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-border-subtle border-t p-3">
          <p className="text-ink-faint truncate px-3 pb-2 text-xs" title={userEmail ?? undefined}>
            {userEmail ?? "Signed in"}
          </p>
          <SignOutButton />
        </div>
      </aside>

      {/* Top bar (mobile) */}
      <div className="flex flex-col lg:min-w-0 lg:flex-1">
        <header className="border-border-subtle bg-surface-raised flex h-14 items-center justify-between border-b px-4 lg:hidden">
          <div className="flex items-center gap-2">
            <MotiMark />
            <span className="text-sm font-semibold tracking-tight">Moti AI</span>
          </div>
          <SignOutButton compact />
        </header>

        <main id="main" className="flex-1 px-4 py-6 pb-24 sm:px-6 lg:px-10 lg:py-8 lg:pb-8">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>

        {/* Bottom tabs (mobile) */}
        <nav
          aria-label="Main"
          className="border-border-subtle bg-surface-raised/95 fixed inset-x-0 bottom-0 z-20 border-t backdrop-blur lg:hidden"
        >
          <ul className="flex">
            {NAV_ITEMS.map((item) => (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  className="text-ink-soft hover:text-accent flex flex-col items-center gap-1 py-2.5 text-xs font-medium"
                >
                  <NavIcon path={item.iconPath} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

function MotiMark() {
  return (
    <span
      aria-hidden="true"
      className="bg-accent grid size-7 place-items-center rounded-lg text-[13px] font-bold text-white"
    >
      M
    </span>
  );
}

/** Shell used by signed-out pages (login, signup). */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <MotiMark />
          <span className="text-base font-semibold tracking-tight">Moti AI</span>
        </div>
        <div id="main">{children}</div>
        <p className="text-ink-faint mt-8 text-center text-xs leading-relaxed">
          Moti AI analyses conversations you export yourself. It never connects to WhatsApp and
          never sends messages for you.
        </p>
      </div>
    </div>
  );
}
