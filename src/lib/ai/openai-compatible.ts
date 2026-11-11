/**
 * OpenAI-compatible Chat Completions adapter.
 *
 * One adapter, many vendors. Anything speaking `POST /chat/completions` works:
 * OpenAI, Google Gemini (OpenAI-compat endpoint), Groq, Mistral, DeepSeek,
 * Together, OpenRouter, xAI, and local runtimes such as Ollama, llama.cpp and
 * LM Studio. That is the point: the app must not be locked to one vendor.
 *
 * Self-hosted endpoints (Ollama, llama.cpp) usually need no key, so the key is
 * optional — but a *hosted* endpoint without a key is almost certainly a
 * misconfiguration, so it is rejected at construction unless `allowNoKey` is set.
 */

import "server-only";

import { ProviderError, redactSecrets } from "./errors";
import { postJson, type TransportOptions } from "./transport";
import type { AnalysisProvider, LlmRequest, LlmResponse, ModelIdentity } from "./types";

export type OpenAiCompatibleConfig = {
  /** Required for hosted vendors; optional for local runtimes. */
  apiKey?: string;
  model: string;
  /** Full base including any version segment, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** Stable id recorded on analysis versions, e.g. "groq", "openai", "ollama". */
  providerId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Permit an empty key (local runtimes). */
  allowNoKey?: boolean;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer. */
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

export class OpenAiCompatibleProvider implements AnalysisProvider {
  readonly identity: ModelIdentity;
  readonly isGenerative = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly transport: Pick<TransportOptions, "fetchImpl">;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    const baseUrl = config.baseUrl?.trim();
    if (!baseUrl) {
      throw new ProviderError("openai-compatible: base URL is required.", {
        kind: "config",
        provider: "openai-compatible",
      });
    }

    // Validate up front: a malformed URL should fail at startup, not mid-analysis.
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ProviderError(`openai-compatible: "${baseUrl}" is not a valid URL.`, {
        kind: "config",
        provider: "openai-compatible",
      });
    }

    const isLocal = LOCAL_HOSTS.has(parsed.hostname);
    const key = config.apiKey?.trim() ?? "";

    if (key.length === 0 && !config.allowNoKey && !isLocal) {
      throw new ProviderError(
        "openai-compatible: an API key is required for a hosted endpoint. " +
          "Set MOTI_ANALYSIS_API_KEY, or MOTI_ANALYSIS_ALLOW_NO_KEY=true for a local runtime.",
        { kind: "config", provider: "openai-compatible" },
      );
    }

    if (parsed.protocol !== "https:" && !isLocal) {
      throw new ProviderError(
        "openai-compatible: a hosted endpoint must use https, so the API key is never sent in clear text.",
        { kind: "config", provider: "openai-compatible" },
      );
    }

    this.apiKey = key;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.extraHeaders = config.extraHeaders ?? {};
    this.transport = config.fetchImpl ? { fetchImpl: config.fetchImpl } : {};

    this.identity = {
      provider: config.providerId?.trim() || "openai-compatible",
      model: config.model,
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey.length > 0) headers.authorization = `Bearer ${this.apiKey}`;

    const messages = [
      { role: "system" as const, content: request.system },
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ];

    const body: Record<string, unknown> = {
      model: this.identity.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: 0.2,
    };

    // Widely supported and materially improves schema compliance.
    if (request.expectJson) body.response_format = { type: "json_object" };

    const result = await postJson({
      provider: this.identity.provider,
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body,
      timeoutMs: this.config.timeoutMs,
      maxAttempts: this.config.maxAttempts,
      ...this.transport,
    });

    const payload = result.json as {
      choices?: Array<{
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    // Some gateways return 200 with an error object.
    if (payload?.error?.message) {
      throw new ProviderError(
        `${this.identity.provider}: ${redactSecrets(payload.error.message).slice(0, 300)}`,
        { kind: "bad_response", provider: this.identity.provider },
      );
    }

    const choice = payload?.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();

    if (text.length === 0) {
      // A refusal is a valid model decision, not a transport failure: surface it
      // clearly rather than retrying, which would only produce the same refusal.
      const refusal = choice?.message?.refusal?.trim();
      throw new ProviderError(
        refusal
          ? `${this.identity.provider}: the model refused the request — ${redactSecrets(refusal).slice(0, 200)}`
          : `${this.identity.provider}: the response contained no message content.`,
        { kind: "bad_response", provider: this.identity.provider, retryable: !refusal },
      );
    }

    return {
      text,
      identity: this.identity,
      usage: payload?.usage
        ? {
            inputTokens: payload.usage.prompt_tokens ?? 0,
            outputTokens: payload.usage.completion_tokens ?? 0,
          }
        : null,
      durationMs: result.durationMs,
      attempts: result.attempts,
    };
  }
}
