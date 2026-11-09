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
   * Analysis provider selection. See src/lib/ai/config.ts for the full list.
   *
   * `deterministic` (default) runs the offline rule engine — genuine analysis,
   * but NOT a language model. Any other value selects a generative provider:
   * `anthropic`, or an OpenAI-compatible one such as `openai`, `gemini`, `groq`,
   * `mistral`, `deepseek`, `together`, `openrouter`, `ollama`, `lmstudio`, or
   * `openai-compatible` with an explicit MOTI_ANALYSIS_BASE_URL.
   */
  MOTI_ANALYSIS_PROVIDER: z.string().min(1).default("deterministic"),

  /** Model name. Falls back to the endpoint preset's default when unset. */
  MOTI_ANALYSIS_MODEL: z.string().optional(),

  /** Overrides the preset endpoint. Required for provider "openai-compatible". */
  MOTI_ANALYSIS_BASE_URL: z.url().optional(),

  /**
   * Server-side only. Never prefix with NEXT_PUBLIC_ and never commit a real key.
   * One variable for every vendor, so setup is identical across providers.
   */
  MOTI_ANALYSIS_API_KEY: z.string().min(8, "looks too short to be an API key").optional(),

  /** Legacy variable, still honoured when the provider is anthropic. */
  ANTHROPIC_API_KEY: z.string().min(20, "looks too short to be an Anthropic key").optional(),

  /** Allow an endpoint with no key. Only sensible for a local runtime. */
  MOTI_ANALYSIS_ALLOW_NO_KEY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** Per-attempt timeout in milliseconds. */
  MOTI_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(120_000),

  /*
   * WhatsApp Business Cloud API — the only official way to send programmatically.
   *
   * Present so readiness can be reported honestly. Setting these does NOT make
   * the app able to send: there is no outbound path and no webhook handler in
   * this build, so a configured token is reported as "configured but unused"
   * rather than as a working integration.
   */
  WHATSAPP_ACCESS_TOKEN: z.string().min(10).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(3).optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(3).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8).optional(),
  WHATSAPP_APP_SECRET: z.string().min(10).optional(),

  /** Total HTTP attempts including the first. */
  MOTI_ANALYSIS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /** Used only for provider attribution headers (e.g. OpenRouter). */
  MOTI_ANALYSIS_APP_URL: z.url().optional(),

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
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN || undefined,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || undefined,
    WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || undefined,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || undefined,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || undefined,
    MOTI_ANALYSIS_PROVIDER: process.env.MOTI_ANALYSIS_PROVIDER || undefined,
    MOTI_ANALYSIS_MODEL: process.env.MOTI_ANALYSIS_MODEL || undefined,
    MOTI_ANALYSIS_BASE_URL: process.env.MOTI_ANALYSIS_BASE_URL || undefined,
    MOTI_ANALYSIS_API_KEY: process.env.MOTI_ANALYSIS_API_KEY || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    MOTI_ANALYSIS_ALLOW_NO_KEY: process.env.MOTI_ANALYSIS_ALLOW_NO_KEY || undefined,
    MOTI_ANALYSIS_TIMEOUT_MS: process.env.MOTI_ANALYSIS_TIMEOUT_MS || undefined,
    MOTI_ANALYSIS_MAX_ATTEMPTS: process.env.MOTI_ANALYSIS_MAX_ATTEMPTS || undefined,
    MOTI_ANALYSIS_APP_URL: process.env.MOTI_ANALYSIS_APP_URL || undefined,
    NODE_ENV: process.env.NODE_ENV,
  });

  if (!parsed.success) {
    throw new EnvValidationError(
      "server",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  /*
   * Provider validity is checked by readProviderConfig, which owns that logic.
   * It is deliberately NOT duplicated here: two sources of truth drifted apart
   * before, and the env schema accepted values the factory then rejected.
   */

  cached = parsed.data;
  return cached;
}

export function __resetServerEnvCacheForTests(): void {
  cached = null;
}
