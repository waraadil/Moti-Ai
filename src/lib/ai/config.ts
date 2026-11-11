/**
 * Provider configuration.
 *
 * Turns environment variables into a validated, typed description of which
 * provider to use. No network access and no secrets leave this module except
 * into `createProvider`, which hands the key straight to the adapter.
 *
 * Configuration is *described* here rather than constructed so it can be
 * inspected by the connectivity diagnostic and by tests without instantiating a
 * provider (and without needing a key).
 */

import "server-only";

import { ENDPOINT_PRESETS } from "./presets";

export const PROVIDER_IDS = [
  "deterministic",
  "anthropic",
  "openai",
  "gemini",
  "groq",
  "mistral",
  "deepseek",
  "together",
  "openrouter",
  "ollama",
  "lmstudio",
  "openai-compatible",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderConfig =
  | { kind: "deterministic" }
  | {
      kind: "anthropic";
      providerId: "anthropic";
      apiKey: string;
      model: string;
      baseUrl: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  | {
      kind: "openai-compatible";
      providerId: ProviderId;
      apiKey: string;
      model: string;
      baseUrl: string;
      timeoutMs: number;
      maxAttempts: number;
      allowNoKey: boolean;
      extraHeaders: Record<string, string>;
    };

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    /** Variable names the person needs to set, for actionable messaging. */
    readonly variables: string[] = [],
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function readInt(value: string | undefined, fallback: number, name: string): number {
  if (!value || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProviderConfigError(`${name} must be a positive number, got "${value}".`, [name]);
  }
  return Math.floor(parsed);
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Reads provider configuration from the environment.
 *
 * Throws `ProviderConfigError` for a configuration that cannot work — a missing
 * key, an unknown provider, a hosted endpoint with no base URL. Failing here
 * means the failure happens at startup with a useful message, rather than
 * halfway through an analysis run.
 */
export function readProviderConfig(source: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const raw = (source.MOTI_ANALYSIS_PROVIDER ?? "deterministic").trim().toLowerCase();

  if (!isProviderId(raw)) {
    throw new ProviderConfigError(
      `Unknown MOTI_ANALYSIS_PROVIDER "${raw}". Known values: ${PROVIDER_IDS.join(", ")}.`,
      ["MOTI_ANALYSIS_PROVIDER"],
    );
  }

  if (raw === "deterministic") return { kind: "deterministic" };

  const timeoutMs = readInt(
    source.MOTI_ANALYSIS_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "MOTI_ANALYSIS_TIMEOUT_MS",
  );
  const maxAttempts = readInt(
    source.MOTI_ANALYSIS_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    "MOTI_ANALYSIS_MAX_ATTEMPTS",
  );

  // One key variable for every vendor keeps setup identical across providers.
  // ANTHROPIC_API_KEY is still honoured so existing setups keep working.
  const apiKey =
    source.MOTI_ANALYSIS_API_KEY?.trim() ||
    (raw === "anthropic" ? source.ANTHROPIC_API_KEY?.trim() : "") ||
    "";
  const modelOverride = source.MOTI_ANALYSIS_MODEL?.trim() || "";
  const baseUrlOverride = source.MOTI_ANALYSIS_BASE_URL?.trim() || "";
  const allowNoKey = (source.MOTI_ANALYSIS_ALLOW_NO_KEY ?? "").trim().toLowerCase() === "true";

  if (raw === "anthropic") {
    if (!apiKey) {
      throw new ProviderConfigError(
        "MOTI_ANALYSIS_PROVIDER=anthropic requires MOTI_ANALYSIS_API_KEY (or ANTHROPIC_API_KEY).",
        ["MOTI_ANALYSIS_API_KEY"],
      );
    }
    return {
      kind: "anthropic",
      providerId: "anthropic",
      apiKey,
      model: modelOverride || DEFAULT_ANTHROPIC_MODEL,
      baseUrl: baseUrlOverride || "https://api.anthropic.com",
      timeoutMs,
      maxAttempts,
    };
  }

  const preset = ENDPOINT_PRESETS[raw];
  const baseUrl = baseUrlOverride || preset.baseUrl;
  const model = modelOverride || preset.defaultModel;

  if (!baseUrl) {
    throw new ProviderConfigError(
      `MOTI_ANALYSIS_PROVIDER=${raw} requires MOTI_ANALYSIS_BASE_URL, because it has no default endpoint.`,
      ["MOTI_ANALYSIS_BASE_URL"],
    );
  }

  if (!model) {
    throw new ProviderConfigError(`MOTI_ANALYSIS_PROVIDER=${raw} requires MOTI_ANALYSIS_MODEL.`, [
      "MOTI_ANALYSIS_MODEL",
    ]);
  }

  const isLocalPreset = preset.local === true;
  if (!apiKey && !allowNoKey && !isLocalPreset) {
    throw new ProviderConfigError(
      `MOTI_ANALYSIS_PROVIDER=${raw} requires MOTI_ANALYSIS_API_KEY. ` +
        "For a local runtime with no key, set MOTI_ANALYSIS_ALLOW_NO_KEY=true.",
      ["MOTI_ANALYSIS_API_KEY"],
    );
  }

  const extraHeaders: Record<string, string> = {};
  // OpenRouter attributes traffic by referer/title; harmless everywhere else.
  if (raw === "openrouter") {
    extraHeaders["http-referer"] = source.MOTI_ANALYSIS_APP_URL?.trim() || "https://moti.ai";
    extraHeaders["x-title"] = "Moti AI";
  }

  return {
    kind: "openai-compatible",
    providerId: raw,
    apiKey,
    model,
    baseUrl,
    timeoutMs,
    maxAttempts,
    allowNoKey: allowNoKey || isLocalPreset,
    extraHeaders,
  };
}

/**
 * A description of the active provider that is safe to show in the UI.
 * Contains no key — only whether one is present.
 */
export type ProviderSummary = {
  configured: boolean;
  provider: ProviderId | "unknown";
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  isGenerative: boolean;
  error: string | null;
  requiredVariables: string[];
};

export function describeProvider(source: NodeJS.ProcessEnv = process.env): ProviderSummary {
  try {
    const config = readProviderConfig(source);

    if (config.kind === "deterministic") {
      return {
        configured: true,
        provider: "deterministic",
        model: null,
        baseUrl: null,
        hasApiKey: false,
        isGenerative: false,
        error: null,
        requiredVariables: [],
      };
    }

    return {
      configured: true,
      provider: config.providerId,
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey: config.apiKey.length > 0,
      isGenerative: true,
      error: null,
      requiredVariables: [],
    };
  } catch (error) {
    const raw = (source.MOTI_ANALYSIS_PROVIDER ?? "deterministic").trim().toLowerCase();
    return {
      configured: false,
      provider: isProviderId(raw) ? raw : "unknown",
      model: null,
      baseUrl: null,
      hasApiKey: false,
      isGenerative: false,
      error: error instanceof Error ? error.message : "Provider configuration is invalid.",
      requiredVariables: error instanceof ProviderConfigError ? error.variables : [],
    };
  }
}
