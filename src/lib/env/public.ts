/**
 * Public environment: `NEXT_PUBLIC_*` values only.
 *
 * This module is safe to import from Client Components. It deliberately does not
 * reference any secret, so nothing sensitive can be inlined into a browser
 * bundle even by accident.
 */

import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ message: "must be a valid https URL" }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, "looks too short to be a Supabase anon key"),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
});

export type PublicEnv = z.infer<typeof publicSchema>;

export class EnvValidationError extends Error {
  readonly scope: "public" | "server";
  readonly issues: string[];

  constructor(scope: "public" | "server", issues: string[]) {
    super(
      `Invalid ${scope} environment configuration:\n` +
        issues.map((issue) => `  - ${issue}`).join("\n") +
        `\n\nCopy .env.example to .env.local and fill in the values.`,
    );
    this.name = "EnvValidationError";
    this.scope = scope;
    this.issues = issues;
  }
}

let cached: PublicEnv | null = null;

/**
 * Validated public environment, cached per process.
 * Throws `EnvValidationError` when a value is missing or malformed.
 */
export function getPublicEnv(): PublicEnv {
  if (cached) return cached;

  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    throw new EnvValidationError(
      "public",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  cached = parsed.data;
  return cached;
}

/** True when Supabase credentials are present. Lets UI render a setup notice. */
export function isPublicEnvConfigured(): boolean {
  return publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  }).success;
}

/** Test-only cache reset. */
export function __resetPublicEnvCacheForTests(): void {
  cached = null;
}
