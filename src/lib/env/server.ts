/**
 * Server-only environment.
 *
 * The `server-only` import is a build-time guard: if any Client Component ever
 * imports this module, `next build` fails instead of shipping the service role
 * key to a browser bundle.
 */

import "server-only";
import { z } from "zod";
import { EnvValidationError } from "./public";

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, "looks too short to be a Supabase service role key")
    .optional(),
  MOTI_ENABLE_DB_VERIFY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * Analysis provider selection.
   *
   * `deterministic` (the default) runs the offline rule engine: real analysis,
   * no network, no cost. `anthropic` sends conversation text to the Claude
   * Messages API and therefore requires ANTHROPIC_API_KEY.
   */
  MOTI_ANALYSIS_PROVIDER: z.enum(["deterministic", "anthropic"]).default("deterministic"),

  /** Model name passed to the provider. Only used when the provider is anthropic. */
  MOTI_ANALYSIS_MODEL: z.string().min(1).default("claude-sonnet-4-5-20250929"),

  /** Server-side only. Never expose this or prefix it with NEXT_PUBLIC_. */
  ANTHROPIC_API_KEY: z.string().min(20, "looks too short to be an Anthropic key").optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Reads server configuration. Throws when running in a browser context, which
 * means a client import slipped through review.
 */
export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "getServerEnv() was called in the browser. Server configuration must never be " +
        "imported by client components; use getPublicEnv() instead.",
    );
  }

  if (cached) return cached;

  const parsed = serverSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    MOTI_ENABLE_DB_VERIFY: process.env.MOTI_ENABLE_DB_VERIFY,
    MOTI_ANALYSIS_PROVIDER: process.env.MOTI_ANALYSIS_PROVIDER || undefined,
    MOTI_ANALYSIS_MODEL: process.env.MOTI_ANALYSIS_MODEL || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    NODE_ENV: process.env.NODE_ENV,
  });

  if (!parsed.success) {
    throw new EnvValidationError(
      "server",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  // Fail loudly at the call site rather than midway through an analysis run:
  // selecting the hosted provider without a key can only ever produce failures.
  if (parsed.data.MOTI_ANALYSIS_PROVIDER === "anthropic" && !parsed.data.ANTHROPIC_API_KEY) {
    throw new EnvValidationError("server", [
      "ANTHROPIC_API_KEY: required when MOTI_ANALYSIS_PROVIDER=anthropic",
    ]);
  }

  cached = parsed.data;
  return cached;
}

export function __resetServerEnvCacheForTests(): void {
  cached = null;
}
