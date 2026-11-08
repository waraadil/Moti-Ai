/**
 * Shared HTTP transport for every provider.
 *
 * Keeping timeout, retry and error classification here means each provider
 * adapter only has to describe *its* request shape and *its* response shape —
 * they cannot accidentally diverge on retry behaviour or error reporting.
 */

import "server-only";

import { ProviderError, kindForStatus, redactSecrets } from "./errors";

export type TransportOptions = {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Milliseconds before a single attempt is aborted. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Base backoff; attempt N waits this long times 2^(N-1). */
  baseDelayMs?: number;
  /** Injected in tests so retries do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock so timeouts are testable without real waiting. */
  now?: () => number;
};

export type TransportResult = {
  /** Parsed JSON body. */
  json: unknown;
  status: number;
  durationMs: number;
  attempts: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 800;

/** Never sleep longer than this, even if the provider asks for more. */
const MAX_BACKOFF_MS = 15_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs JSON with bounded retries.
 *
 * Retries only happen for failures where a retry could plausibly succeed
 * (rate limits, 5xx, timeouts, network). Authentication and bad-request errors
 * fail immediately: retrying a rejected key just burns quota.
 */
export async function postJson(options: TransportOptions): Promise<TransportResult> {
  const {
    provider,
    url,
    headers,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = defaultSleep,
    fetchImpl = fetch,
  } = options;

  const startedAt = Date.now();
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await attemptOnce(attempt);
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError("Unexpected transport failure.", {
              kind: "network",
              provider,
              cause: error,
            });

      lastError = providerError;

      const isLast = attempt >= maxAttempts;
      if (!providerError.retryable || isLast) throw providerError;

      // Respect Retry-After when the provider supplies it, otherwise back off.
      const requested = providerError.retryAfterSeconds;
      const backoff =
        requested !== null ? requested * 1000 : baseDelayMs * Math.pow(2, attempt - 1);

      await sleep(Math.min(backoff, MAX_BACKOFF_MS));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError ?? new ProviderError("Transport failed.", { kind: "network", provider });

  async function attemptOnce(attempt: number): Promise<TransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // An aborted fetch is a timeout; anything else is a network failure.
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));

      throw new ProviderError(
        aborted
          ? `${provider}: request timed out after ${timeoutMs}ms.`
          : `${provider}: could not reach ${safeHost(url)}.`,
        {
          kind: aborted ? "timeout" : "network",
          provider,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `${provider}: HTTP ${response.status}${detail ? ` — ${truncate(redactSecrets(detail))}` : ""}`,
        {
          kind: kindForStatus(response.status),
          provider,
          status: response.status,
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        },
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new ProviderError(`${provider}: response was not valid JSON.`, {
        kind: "bad_response",
        provider,
        status: response.status,
        cause: error,
      });
    }

    return {
      json,
      status: response.status,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  }
}

function truncate(value: string, limit = 300): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** Host only — never log a full URL, which could carry a key in a query string. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured endpoint";
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}
