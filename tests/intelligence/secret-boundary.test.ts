/**
 * Secret-boundary tests.
 *
 * Static assertions, deliberately. The `server-only` marker is what makes
 * `next build` fail if a Client Component ever pulls an AI module into the
 * browser bundle — so a missing marker is a silent security regression that no
 * behavioural test would catch.
 *
 * These read the source files rather than importing them, because importing
 * `server-only` throws outside a Next.js server graph.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AI_DIR = path.join(process.cwd(), "src/lib/ai");

/** Modules that read, hold or forward an API key. */
const SECRET_HANDLING_MODULES = [
  "index.ts",
  "config.ts",
  "diagnose.ts",
  "anthropic.ts",
  "openai-compatible.ts",
  "transport.ts",
  "errors.ts",
  "presets.ts",
  "types.ts",
];

function read(name: string): string {
  return readFileSync(path.join(AI_DIR, name), "utf8");
}

describe("server-only boundary", () => {
  it("guards every AI module that could carry a key", () => {
    for (const file of SECRET_HANDLING_MODULES) {
      const source = read(file);

      // `types.ts` and `presets.ts` are pure data/type declarations: no secrets,
      // no I/O. Everything that performs a request must be guarded.
      const performsIo = /\bfetch\b|process\.env|apiKey/.test(source);
      if (!performsIo) continue;

      expect(source, `${file} must import "server-only"`).toMatch(/import\s+"server-only"/);
    }
  });

  it("has no client component importing the AI layer", () => {
    const componentsDir = path.join(process.cwd(), "src/components");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;

        const source = readFileSync(full, "utf8");
        const isClient = source.includes('"use client"');
        if (isClient && /from\s+"@\/lib\/ai/.test(source)) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };

    walk(componentsDir);
    expect(offenders).toEqual([]);
  });
});

describe("no committed credentials", () => {
  it("contains no key-shaped strings in source or scripts", () => {
    const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "scripts")];
    // Deliberately narrow: real credentials are long and high-entropy.
    const suspicious =
      /\b(sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,})/;
    const found: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;

        const source = readFileSync(full, "utf8");
        if (suspicious.test(source)) found.push(path.relative(process.cwd(), full));
      }
    };

    for (const root of roots) walk(root);
    expect(found).toEqual([]);
  });

  it("documents every provider variable in .env.example", () => {
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

    for (const variable of [
      "MOTI_ANALYSIS_PROVIDER",
      "MOTI_ANALYSIS_API_KEY",
      "MOTI_ANALYSIS_MODEL",
      "MOTI_ANALYSIS_BASE_URL",
      "MOTI_ANALYSIS_ALLOW_NO_KEY",
      "MOTI_ANALYSIS_TIMEOUT_MS",
      "MOTI_ANALYSIS_MAX_ATTEMPTS",
    ]) {
      expect(example, `.env.example must document ${variable}`).toContain(variable);
    }
  });

  it("never prefixes an API key with NEXT_PUBLIC_", () => {
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    // A NEXT_PUBLIC_ key would be inlined into the browser bundle by Next.js.
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*API_KEY/);
  });
});
