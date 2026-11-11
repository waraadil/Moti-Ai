/**
 * Adapter tests: both real provider implementations, driven through a mocked
 * HTTP layer.
 *
 * These exercise the code that actually ships — request shape, header building,
 * response parsing, retry classification and error reporting — without a network
 * call or an API key.
 */

import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";
import { ProviderError, redactSecrets } from "@/lib/ai/errors";
import { postJson } from "@/lib/ai/transport";
import {
  anthropicResponse,
  createMockFetch,
  hangingFetch,
  openAiResponse,
} from "../helpers/mock-provider";

const KEY = "sk-test-" + "y".repeat(32);
const REQUEST = {
  system: "You extract facts.",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 100,
  expectJson: true,
};

/** No real waiting between retries. */
const noSleep = async () => {};

describe("AnthropicProvider", () => {
  it("sends the documented request shape", async () => {
    const mock = createMockFetch([{ kind: "json", body: anthropicResponse("[]") }]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "claude-sonnet-4-5",
      fetchImpl: mock.fetchImpl,
    });

    await provider.complete(REQUEST);

    const call = mock.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBeTruthy();
    // The key must never travel in the URL or a bearer header.
    expect(call.url).not.toContain(KEY);
    expect(call.headers.authorization).toBeUndefined();
  });

  it("parses text and usage from the response", async () => {
    const mock = createMockFetch([{ kind: "json", body: anthropicResponse('{"a":1}') }]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "claude-sonnet-4-5",
      fetchImpl: mock.fetchImpl,
    });

    const response = await provider.complete(REQUEST);

    expect(response.text).toBe('{"a":1}');
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(response.identity).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(response.attempts).toBe(1);
  });

  it("rejects an empty key at construction", () => {
    expect(() => new AnthropicProvider({ apiKey: "", model: "m" })).toThrow(ProviderError);
  });

  it("treats a 401 as terminal and does not retry", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 401, body: { error: "invalid x-api-key" } },
    ]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "m",
      fetchImpl: mock.fetchImpl,
    });

    await expect(provider.complete({ ...REQUEST, maxTokens: 10 })).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
    });

    expect(mock.callCount).toBe(1);
  });

  it("retries a 429 and succeeds on the second attempt", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 429, body: { error: "rate limited" } },
      { kind: "json", body: anthropicResponse("ok") },
    ]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "m",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 3,
    });

    // The provider uses its own default sleep; assert only on the outcome.
    const response = await provider.complete(REQUEST);
    expect(response.text).toBe("ok");
    expect(mock.callCount).toBe(2);
  }, 10_000);

  it("reports a network failure clearly instead of throwing raw", async () => {
    const mock = createMockFetch([{ kind: "throw", error: new Error("ECONNREFUSED") }]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "m",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 1,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      kind: "network",
      retryable: true,
    });
  });

  it("reports an empty completion as a bad response", async () => {
    const mock = createMockFetch([{ kind: "json", body: { content: [] } }]);
    const provider = new AnthropicProvider({
      apiKey: KEY,
      model: "m",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 1,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("OpenAiCompatibleProvider", () => {
  it("sends a bearer token and a system message", async () => {
    const mock = createMockFetch([{ kind: "json", body: openAiResponse('{"ok":true}') }]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      providerId: "openai",
      fetchImpl: mock.fetchImpl,
    });

    await provider.complete(REQUEST);

    const call = mock.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);

    const body = call.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: "system", content: "You extract facts." });
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("asks for JSON mode when the caller expects JSON", async () => {
    const mock = createMockFetch([{ kind: "json", body: openAiResponse("{}") }]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "m",
      baseUrl: "https://api.example.com/v1",
      fetchImpl: mock.fetchImpl,
    });

    await provider.complete({ ...REQUEST, expectJson: true });

    const body = mock.calls[0]!.body as { response_format?: { type: string } };
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits JSON mode when not requested", async () => {
    const mock = createMockFetch([{ kind: "json", body: openAiResponse("{}") }]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "m",
      baseUrl: "https://api.example.com/v1",
      fetchImpl: mock.fetchImpl,
    });

    await provider.complete({ ...REQUEST, expectJson: false });

    const body = mock.calls[0]!.body as { response_format?: unknown };
    expect(body.response_format).toBeUndefined();
  });

  it("records the vendor id, not a generic name", async () => {
    const mock = createMockFetch([{ kind: "json", body: openAiResponse("hi") }]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
      providerId: "groq",
      fetchImpl: mock.fetchImpl,
    });

    const response = await provider.complete(REQUEST);
    expect(response.identity.provider).toBe("groq");
  });

  it("refuses a hosted endpoint with no key", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider({
          model: "m",
          baseUrl: "https://api.openai.com/v1",
        }),
    ).toThrow(/API key is required/i);
  });

  it("allows a local endpoint with no key", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider({
          model: "llama3.1:8b",
          baseUrl: "http://localhost:11434/v1",
          providerId: "ollama",
        }),
    ).not.toThrow();
  });

  it("rejects plain http for a hosted endpoint so the key is never sent in clear", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider({
          apiKey: KEY,
          model: "m",
          baseUrl: "http://api.example.com/v1",
        }),
    ).toThrow(/https/i);
  });

  it("rejects an invalid base URL at construction", () => {
    expect(
      () => new OpenAiCompatibleProvider({ apiKey: KEY, model: "m", baseUrl: "not a url" }),
    ).toThrow(/valid URL/i);
  });

  it("surfaces an error object returned inside a 200 body", async () => {
    const mock = createMockFetch([
      { kind: "json", body: { error: { message: "model `gpt-9` does not exist" } } },
    ]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "gpt-9",
      baseUrl: "https://api.example.com/v1",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 1,
    });

    await expect(provider.complete(REQUEST)).rejects.toThrow(/does not exist/);
  });

  it("reports a refusal without retrying", async () => {
    const mock = createMockFetch([
      {
        kind: "json",
        body: {
          choices: [{ message: { content: null, refusal: "I can't help with that." } }],
        },
      },
    ]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "m",
      baseUrl: "https://api.example.com/v1",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 3,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ retryable: false });
    expect(mock.callCount).toBe(1);
  });

  it("redacts a key echoed back by the provider in an error message", async () => {
    const mock = createMockFetch([
      { kind: "text", status: 400, body: `Incorrect API key provided: ${KEY}` },
    ]);
    const provider = new OpenAiCompatibleProvider({
      apiKey: KEY,
      model: "m",
      baseUrl: "https://api.example.com/v1",
      fetchImpl: mock.fetchImpl,
      maxAttempts: 1,
    });

    try {
      await provider.complete(REQUEST);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).toContain("[redacted-key]");
    }
  });
});

describe("transport", () => {
  const base = {
    provider: "test",
    url: "https://api.example.com/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: { ping: true },
    sleep: noSleep,
  };

  it("aborts a hung request and reports a timeout", async () => {
    await expect(
      postJson({ ...base, fetchImpl: hangingFetch(), timeoutMs: 30, maxAttempts: 1 }),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });

  it("honours Retry-After on a 429", async () => {
    const waits: number[] = [];
    const mock = createMockFetch([
      { kind: "json", status: 429, body: {}, headers: { "retry-after": "2" } },
      { kind: "json", body: { ok: true } },
    ]);

    await postJson({
      ...base,
      fetchImpl: mock.fetchImpl,
      maxAttempts: 2,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([2000]);
  });

  it("gives up after maxAttempts and reports the last error", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 500, body: {} },
      { kind: "json", status: 500, body: {} },
      { kind: "json", status: 500, body: {} },
    ]);

    await expect(
      postJson({ ...base, fetchImpl: mock.fetchImpl, maxAttempts: 3 }),
    ).rejects.toMatchObject({ kind: "server" });

    expect(mock.callCount).toBe(3);
  });

  it("does not retry a 400", async () => {
    const mock = createMockFetch([{ kind: "json", status: 400, body: { error: "bad" } }]);

    await expect(
      postJson({ ...base, fetchImpl: mock.fetchImpl, maxAttempts: 3 }),
    ).rejects.toMatchObject({ kind: "bad_request" });

    expect(mock.callCount).toBe(1);
  });

  it("treats a non-JSON 200 body as a bad response", async () => {
    const mock = createMockFetch([{ kind: "text", status: 200, body: "not json at all" }]);

    await expect(
      postJson({ ...base, fetchImpl: mock.fetchImpl, maxAttempts: 1 }),
    ).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("secret redaction", () => {
  it("removes common key shapes", () => {
    expect(redactSecrets("key sk-abc123def456ghi")).toContain("[redacted-key]");
    expect(redactSecrets("key sk-ant-api03-abcdefgh")).toContain("[redacted-key]");
    expect(redactSecrets("AIzaSyA1234567890abcdefghijklmn")).toContain("[redacted-key]");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "The model returned an empty completion.";
    expect(redactSecrets(text)).toBe(text);
  });
});
