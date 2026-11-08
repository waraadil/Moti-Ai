/**
 * Anthropic Messages API adapter.
 *
 * Written against the documented REST shape. The API key is held in a private
 * field, never logged, and this module is `server-only`.
 */

import "server-only";

import { ProviderError } from "./errors";
import { postJson, type TransportOptions } from "./transport";
import type { AnalysisProvider, LlmRequest, LlmResponse, ModelIdentity } from "./types";

export type AnthropicConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Test seam: replaces global fetch. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider implements AnalysisProvider {
  readonly identity: ModelIdentity;
  readonly isGenerative = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: Pick<TransportOptions, "fetchImpl">;

  constructor(private readonly config: AnthropicConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new ProviderError("Anthropic API key is empty.", {
        kind: "config",
        provider: "anthropic",
      });
    }

    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = config.fetchImpl ? { fetchImpl: config.fetchImpl } : {};
    this.identity = { provider: "anthropic", model: config.model };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const result = await postJson({
      provider: "anthropic",
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model: this.identity.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
      timeoutMs: this.config.timeoutMs,
      maxAttempts: this.config.maxAttempts,
      ...this.transport,
    });

    const text = extractText(result.json);

    if (text.length === 0) {
      throw new ProviderError("anthropic: the response contained no text content.", {
        kind: "bad_response",
        provider: "anthropic",
      });
    }

    return {
      text,
      identity: this.identity,
      usage: extractUsage(result.json),
      durationMs: result.durationMs,
      attempts: result.attempts,
    };
  }
}

/** `{ content: [{ type: "text", text: "..." }] }` → joined text. */
function extractText(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type?: string; text?: string } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

function extractUsage(payload: unknown): { inputTokens: number; outputTokens: number } | null {
  const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage;
  if (!usage) return null;

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}
