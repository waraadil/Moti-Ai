"use client";

/**
 * Route-level error boundary.
 * Shows a recoverable message; the digest is safe to share with support.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center"
    >
      <h1 className="text-ink text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-ink-soft mt-2 text-sm leading-relaxed">
        This page could not be loaded. Nothing was changed.
      </p>
      {error.digest ? (
        <p className="text-ink-faint mt-2 font-mono text-xs">Reference: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="bg-accent mt-6 rounded-lg px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
      >
        Try again
      </button>
    </main>
  );
}
