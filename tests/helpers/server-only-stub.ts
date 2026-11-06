/**
 * Vitest stand-in for the `server-only` marker package.
 *
 * In a Next.js build, importing `server-only` from client code is a hard error.
 * Under Vitest there is no server/client graph, so the marker is aliased to this
 * empty module via vitest.config.mts.
 */
export {};
