/**
 * The provider contract.
 *
 * Deliberately small: a provider takes a system prompt, a list of turns and a
 * token budget, and returns text plus provenance. It knows nothing about
 * memories, style, replies or the database. Everything it returns is validated
 * by the caller with a Zod schema before it can affect stored data.
 */

export type ModelIdentity = {
  /** Stable provider id, recorded on every analysis version. */
  provider: string;
  model: string;
};

/**
 * Bumped whenever a prompt or extraction contract changes in a way that should
 * invalidate cached analyses. Part of the run's input hash.
 */
export const PROMPT_VERSION = "2026-11-07.2";

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  /** Upper bound on generated tokens. */
  maxTokens: number;
  /**
   * When true, the provider is told to return JSON only. Providers do not parse
   * or validate it — the caller does, because the schemas live above this layer.
   */
  expectJson: boolean;
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type LlmResponse = {
  text: string;
  identity: ModelIdentity;
  usage: LlmUsage | null;
  durationMs: number;
  /** How many HTTP attempts this took. 1 means it succeeded first time. */
  attempts: number;
};

export interface AnalysisProvider {
  readonly identity: ModelIdentity;
  /** True only for providers that call a real generative model. */
  readonly isGenerative: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
