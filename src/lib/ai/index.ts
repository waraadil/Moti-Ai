/**
 * Provider factory.
 *
 * Selection is explicit. There is no automatic fallback from a hosted model to
 * the rule engine: silently degrading would make results look better than they
 * are, and the provenance recorded on each analysis version would be wrong.
 */

import "server-only";

import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { DeterministicProvider } from "./deterministic";
import {
  describeProvider,
  readProviderConfig,
  type ProviderConfig,
  type ProviderSummary,
} from "./config";
import type { AnalysisProvider } from "./types";

export * from "./types";
export * from "./errors";
export {
  PROVIDER_IDS,
  readProviderConfig,
  describeProvider,
  ProviderConfigError,
  type ProviderConfig,
  type ProviderSummary,
  type ProviderId,
} from "./config";
export { ENDPOINT_PRESETS, type EndpointPreset } from "./presets";
export { AnthropicProvider } from "./anthropic";
export { OpenAiCompatibleProvider } from "./openai-compatible";
export { DeterministicProvider, runTask, buildReplyDrafts } from "./deterministic";
export { diagnoseProvider, type DiagnosticReport, type DiagnosticCheck } from "./diagnose";

export type ProviderBundle =
  | { kind: "deterministic"; provider: DeterministicProvider }
  | { kind: "generative"; provider: AnalysisProvider; providerId: string };

/** Builds a provider from an already-validated config. */
export function providerFromConfig(config: ProviderConfig): ProviderBundle {
  if (config.kind === "deterministic") {
    return { kind: "deterministic", provider: new DeterministicProvider() };
  }

  if (config.kind === "anthropic") {
    return {
      kind: "generative",
      providerId: config.providerId,
      provider: new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
      }),
    };
  }

  return {
    kind: "generative",
    providerId: config.providerId,
    provider: new OpenAiCompatibleProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      providerId: config.providerId,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      allowNoKey: config.allowNoKey,
      extraHeaders: config.extraHeaders,
    }),
  };
}

/** Reads the environment and builds the configured provider. */
export function createProvider(source: NodeJS.ProcessEnv = process.env): ProviderBundle {
  return providerFromConfig(readProviderConfig(source));
}

/** True when a real generative model is configured and usable. */
export function isGenerativeConfigured(source: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readProviderConfig(source).kind !== "deterministic";
  } catch {
    return false;
  }
}

/** Safe-to-display provider description; contains no secret material. */
export function providerSummary(source: NodeJS.ProcessEnv = process.env): ProviderSummary {
  return describeProvider(source);
}

/** Human-readable label for the UI. */
export function providerLabel(source: NodeJS.ProcessEnv = process.env): string {
  const summary = describeProvider(source);

  if (!summary.configured) {
    return `unavailable — ${summary.error ?? "not configured"}`;
  }
  if (summary.provider === "deterministic") {
    return "Moti rule engine (deterministic, offline — not a language model)";
  }
  return `${summary.provider} · ${summary.model}`;
}
