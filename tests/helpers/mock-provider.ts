/**
 * Mocked HTTP layer for provider tests.
 *
 * Lets the real adapters (AnthropicProvider, OpenAiCompatibleProvider) run
 * unmodified against scripted responses. This is how the vendor-specific HTTP
 * handling gets exercised without network access or an API key.
 */

export type MockCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type MockResponse =
  | { kind: "json"; status?: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "throw"; error: Error }
  | { kind: "abort" };

/**
 * Builds a fetch-compatible function from a list of scripted responses.
 * Calls are recorded so tests can assert on the request actually sent.
 */
export function createMockFetch(responses: MockResponse[]) {
  const calls: MockCall[] = [];
  let index = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = String(value);
    }

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    const scripted = responses[index];
    index += 1;

    if (!scripted) {
      throw new Error(`Mock fetch exhausted: no scripted response for call ${index} (${url})`);
    }

    if (scripted.kind === "throw") throw scripted.error;
    if (scripted.kind === "abort") {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }

    if (scripted.kind === "text") {
      return new Response(scripted.body, {
        status: scripted.status,
        headers: scripted.headers,
      });
    }

    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status ?? 200,
      headers: { "content-type": "application/json", ...scripted.headers },
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    get callCount() {
      return calls.length;
    },
  };
}

/** A well-formed Anthropic Messages response. */
export function anthropicResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 120, output_tokens: 45 },
  };
}

/** A well-formed OpenAI chat completion response. */
export function openAiResponse(text: string) {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  };
}

/** Never resolves' sibling: a fetch that respects AbortSignal and hangs. */
export function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;
}
