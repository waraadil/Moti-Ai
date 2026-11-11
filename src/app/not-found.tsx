import Link from "next/link";

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center"
    >
      <p className="text-ink-faint text-xs font-semibold tracking-widest uppercase">404</p>
      <h1 className="text-ink mt-2 text-xl font-semibold tracking-tight">Nothing here</h1>
      <p className="text-ink-soft mt-2 text-sm leading-relaxed">
        This page does not exist, or the record belongs to a different account.
      </p>
      <Link
        href="/contacts"
        className="bg-accent mt-6 rounded-lg px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
      >
        Back to contacts
      </Link>
    </main>
  );
}
