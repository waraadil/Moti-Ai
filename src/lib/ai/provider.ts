/**
 * AI provider abstraction.
 *
 * Two implementations share one interface and one set of validated schemas:
 *
 *   - `AnthropicProvider` — calls the real model over HTTPS. Server only.
 *   - `DeterministicProvider` — rule-based extraction over the same transcript.
 *     It is *not* a mock of the model: it is a genuine analyser that produces
 *     schema-valid results, used when no API key is configured and in tests so
 *     the pipeline is testable without network access or cost.
 *
 * The active provider is recorded on every analysis version, so a result can
 * always be traced to what produced it.
 */

import "server-only";

export type ModelIdentity = {
  provider: string;
  model: string;
};

export const PROMPT_VERSION = "2026-11-07.1";

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
   * When set, the provider must return JSON matching this description. Both
   * providers return raw text; the caller validates it with Zod.
   */
  expectJson: boolean;
};

export type LlmResponse = {
  text: string;
  identity: ModelIdentity;
  usage: { inputTokens: number; outputTokens: number } | null;
  durationMs: number;
};

export interface AnalysisProvider {
  readonly identity: ModelIdentity;
  /** True when this provider calls a real generative model. */
  readonly isGenerative: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Anthropic Messages API client.
 *
 * Written against the documented REST shape and kept dependency-free so the
 * request/response contract is visible and auditable. The API key never leaves
 * the server: this module is `server-only`, and construction throws if it is
 * ever handed an empty key.
 */
export class AnthropicProvider implements AnalysisProvider {
  readonly identity: ModelIdentity;
  readonly isGenerative = true;

  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-sonnet-4-5",
    private readonly baseUrl = "https://api.anthropic.com",
  ) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ProviderError("Anthropic API key is empty.");
    }
    this.identity = { provider: "anthropic", model };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
        }),
        // Analysis is not interactive; a hard timeout keeps a hung request from
        // blocking a retry.
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new ProviderError("Could not reach the Anthropic API.", {
        retryable: true,
        cause: error,
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // 429 and 5xx are worth retrying; 4xx client errors are not.
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        `Anthropic API returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        { retryable },
      );
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (payload.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    if (text.length === 0) {
      throw new ProviderError("Anthropic API returned an empty completion.", { retryable: true });
    }

    return {
      text,
      identity: this.identity,
      usage: payload.usage
        ? {
            inputTokens: payload.usage.input_tokens ?? 0,
            outputTokens: payload.usage.output_tokens ?? 0,
          }
        : null,
      durationMs: Date.now() - startedAt,
    };
  }
}
