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
    NODE_ENV: process.env.NODE_ENV,
  });

  if (!parsed.success) {
    throw new EnvValidationError(
      "server",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  cached = parsed.data;
  return cached;
}

export function __resetServerEnvCacheForTests(): void {
  cached = null;
}
