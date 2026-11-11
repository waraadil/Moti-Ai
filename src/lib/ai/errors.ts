/**
 * Provider errors.
 *
 * A single error type carries everything a caller needs to decide what to do:
 * whether a retry could help, which provider failed, and a message that is safe
 * to surface without leaking the API key or the full prompt.
 */

/**
 * Why a provider call failed. Kept as a closed set so UI and logs can branch on
 * it without string matching.
 *
 * - `auth`        bad or missing key — retrying will not help
 * - `rate_limit`  provider throttled us — retry with backoff
 * - `timeout`     no response within the deadline — retry
 * - `network`     could not reach the host at all — retry
 * - `server`      5xx from the provider — retry
 * - `bad_request` the provider rejected the request shape — do not retry
 * - `bad_response` 2xx but unusable body/empty completion — retry once
 * - `config`      the provider is misconfigured — do not retry
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "bad_request"
  | "bad_response"
  | "config";

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  timeout: true,
  network: true,
  server: true,
  bad_request: false,
  bad_response: true,
  config: false,
};

/** Human-readable advice, shown in the settings diagnostic and error messages. */
const ADVICE: Record<ProviderErrorKind, string> = {
  auth: "The API key was rejected. Check it is correct and has not been revoked.",
  rate_limit: "The provider is rate limiting this key. Wait a moment and try again.",
  timeout: "The provider did not respond in time. The analysis was not saved.",
  network: "The endpoint could not be reached. Check the base URL and your network.",
  server: "The provider had a server error. This is usually temporary.",
  bad_request: "The provider rejected the request. Check the model name is valid.",
  bad_response: "The provider returned an unusable response.",
  config: "The analysis provider is not configured correctly.",
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Provider id, e.g. "anthropic" or "openai-compatible". */
  readonly provider: string | null;
  /** HTTP status when the failure came from a response. */
  readonly status: number | null;
  /** Seconds to wait, when the provider told us (Retry-After). */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      kind?: ProviderErrorKind;
      provider?: string | null;
      status?: number | null;
      retryAfterSeconds?: number | null;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind ?? "bad_response";
    this.retryable = options.retryable ?? RETRYABLE[this.kind];
    this.provider = options.provider ?? null;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  /** Short, non-sensitive explanation plus what the person can do about it. */
  get userMessage(): string {
    return ADVICE[this.kind];
  }
}

/** Maps an HTTP status onto an error kind. 4xx is terminal except 408/429. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "bad_response";
}

/**
 * Removes anything that looks like a credential from text bound for a log or a
 * database column. Provider error bodies sometimes echo the key back.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/sk-ant-[a-zA-Z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/(authorization|api[-_]?key|bearer)\s*[:=]\s*\S+/gi, "$1: [redacted]");
}
