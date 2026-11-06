import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Booting an in-memory PostgreSQL per test file is not cheap.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.join(process.cwd(), "src"),
      // The real package throws outside a Next.js server graph.
      "server-only": path.join(process.cwd(), "tests/helpers/server-only-stub.ts"),
    },
  },
});
