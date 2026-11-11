export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-10"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="bg-surface-sunken h-6 w-40 animate-pulse rounded" />
      <div className="bg-surface-sunken mt-3 h-3 w-72 animate-pulse rounded" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="bg-surface-sunken h-28 animate-pulse rounded-xl" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
