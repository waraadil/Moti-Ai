/**
 * Provider selection.
 *
 * Explicit opt-in, because silently falling back to a weaker analyser would make
 * results look better than they are:
 *
 *   MOTI_ANALYSIS_PROVIDER=anthropic   -> real model, requires ANTHROPIC_API_KEY
 *   MOTI_ANALYSIS_PROVIDER=deterministic (default) -> rule engine, no network
 *
 * If `anthropic` is selected without a key, construction throws rather than
 * degrading quietly. The selected provider is recorded on every analysis version.
 */

import "server-only";

import { AnthropicProvider, type AnalysisProvider } from "./provider";
import { DeterministicProvider } from "./deterministic";

export * from "./provider";
export { DeterministicProvider, runTask, buildReplyDrafts } from "./deterministic";

export type ProviderSelection = {
  kind: "anthropic" | "deterministic";
  /** Null for deterministic. */
  apiKey: string | null;
  model: string | null;
};

export function readProviderSelection(source: NodeJS.ProcessEnv = process.env): ProviderSelection {
  const requested = (source.MOTI_ANALYSIS_PROVIDER ?? "deterministic").trim().toLowerCase();
  const apiKey = source.ANTHROPIC_API_KEY?.trim() ?? "";
  const model = source.MOTI_ANALYSIS_MODEL?.trim() || "claude-sonnet-4-5";

  if (requested === "anthropic") {
    if (!apiKey) {
      throw new Error(
        "MOTI_ANALYSIS_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set. " +
          "Set the key, or use MOTI_ANALYSIS_PROVIDER=deterministic for the offline rule engine.",
      );
    }
    return { kind: "anthropic", apiKey, model };
  }

  if (requested !== "deterministic") {
    throw new Error(
      `Unknown MOTI_ANALYSIS_PROVIDER "${requested}". Use "anthropic" or "deterministic".`,
    );
  }

  return { kind: "deterministic", apiKey: null, model: null };
}

export type ProviderBundle =
  | { kind: "anthropic"; provider: AnalysisProvider }
  | { kind: "deterministic"; provider: DeterministicProvider };

/**
 * Creates the configured provider.
 * The Anthropic key is read from the environment here and never returned to a caller.
 */
export function createProvider(
  selection: ProviderSelection = readProviderSelection(),
): ProviderBundle {
  if (selection.kind === "anthropic" && selection.apiKey) {
    return {
      kind: "anthropic",
      provider: new AnthropicProvider(selection.apiKey, selection.model ?? undefined),
    };
  }

  return { kind: "deterministic", provider: new DeterministicProvider() };
}

/** True when a real generative model is configured. Shown in the UI. */
export function isGenerativeConfigured(): boolean {
  try {
    return readProviderSelection().kind === "anthropic";
  } catch {
    return false;
  }
}
