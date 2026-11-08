/**
 * Connectivity diagnostic.
 *
 * Answers the only question that matters when an AI feature fails: *can this
 * machine actually reach the configured endpoint?* Reports each stage
 * separately — DNS, TLS, HTTP, auth, model — so a network block is never
 * mistaken for a bad key, and a bad key is never mistaken for a code bug.
 *
 * Never returns the API key. Every outbound string is redacted before it can
 * reach a log, a database column or the UI.
 */

import "server-only";

import { ProviderError, redactSecrets, type ProviderErrorKind } from "./errors";
import { readProviderConfig, type ProviderConfig } from "./config";
import { postJson } from "./transport";

export type DiagnosticStage = "config" | "reachability" | "auth" | "completion";

export type DiagnosticCheck = {
  stage: DiagnosticStage;
  ok: boolean;
  /** One line, safe to display. */
  detail: string;
  /** What the person should do about it. */
  hint?: string;
  durationMs?: number;
};

export type DiagnosticReport = {
  ok: boolean;
  provider: string;
  model: string | null;
  baseUrl: string | null;
  isGenerative: boolean;
  checks: DiagnosticCheck[];
  /** Populated when the failure is attributable to a specific error kind. */
  errorKind: ProviderErrorKind | null;
};

export type DiagnoseOptions = {
  source?: NodeJS.ProcessEnv;
  /** Skip the paid completion call and stop after auth. */
  skipCompletion?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
};

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Runs the full diagnostic.
 *
 * The completion probe costs a few tokens; it is the only way to distinguish
 * "the key is valid" from "the key is valid *and* the model name exists and the
 * account has quota".
 */
export async function diagnoseProvider(options: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];

  // --- 1. Configuration ---------------------------------------------------
  let config: ProviderConfig;
  try {
    config = readProviderConfig(options.source);
  } catch (error) {
    return {
      ok: false,
      provider: "unknown",
      model: null,
      baseUrl: null,
      isGenerative: false,
      errorKind: "config",
      checks: [
        {
          stage: "config",
          ok: false,
          detail: error instanceof Error ? error.message : "Provider configuration is invalid.",
          hint: "Set the variables listed in .env.example, then restart the server.",
        },
      ],
    };
  }

  if (config.kind === "deterministic") {
    return {
      ok: true,
      provider: "deterministic",
      model: null,
      baseUrl: null,
      isGenerative: false,
      errorKind: null,
      checks: [
        {
          stage: "config",
          ok: true,
          detail: "Deterministic rule engine selected. No network call is made.",
          hint: "This is not a language model. Set MOTI_ANALYSIS_PROVIDER to a generative provider to use one.",
        },
      ],
    };
  }

  const baseUrl = config.baseUrl;
  const hasKey = config.apiKey.length > 0;

  checks.push({
    stage: "config",
    ok: true,
    detail:
      `Provider "${config.providerId}" configured with model "${config.model}"` +
      (hasKey ? "; an API key is present." : "; no API key (allowed for local runtimes)."),
  });

  const timeoutMs = options.timeoutMs ?? Math.min(config.timeoutMs, PROBE_TIMEOUT_MS);

  // --- 2. Reachability ----------------------------------------------------
  const reachability = await probeReachability(baseUrl, timeoutMs, options.fetchImpl);
  checks.push(reachability.check);

  if (!reachability.check.ok) {
    return {
      ok: false,
      provider: config.providerId,
      model: config.model,
      baseUrl,
      isGenerative: true,
      errorKind: "network",
      checks,
    };
  }

  if (options.skipCompletion) {
    return {
      ok: checks.every((check) => check.ok),
      provider: config.providerId,
      model: config.model,
      baseUrl,
      isGenerative: true,
      errorKind: null,
      checks,
    };
  }

  // --- 3 & 4. Auth + completion (a real request) --------------------------
  const probe = await probeCompletion(config, timeoutMs, options);
  checks.push(probe.check);

  return {
    ok: probe.check.ok,
    provider: config.providerId,
    model: config.model,
    baseUrl,
    isGenerative: true,
    errorKind: probe.errorKind,
    checks,
  };
}

/**
 * Any HTTP response proves the endpoint is reachable. A 4xx from this bare GET is
 * a *success* for this check: it means DNS, TCP and TLS all worked. Only a
 * transport-level failure counts as unreachable.
 */
async function probeReachability(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ check: DiagnosticCheck }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetchImpl(baseUrl, {
      method: "GET",
      signal: controller.signal,
      // Never follow to another origin with credentials attached.
      redirect: "manual",
    });

    return {
      check: {
        stage: "reachability",
        ok: true,
        detail: `Reached ${hostOf(baseUrl)} — DNS, TCP and TLS all succeeded.`,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      check: {
        stage: "reachability",
        ok: false,
        detail: aborted
          ? `Timed out after ${timeoutMs}ms contacting ${hostOf(baseUrl)}.`
          : `Could not reach ${hostOf(baseUrl)}: ${redactSecrets(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 200)}`,
        hint:
          "This is a network problem, not a code or key problem. Check the base URL, " +
          "and confirm outbound HTTPS to this host is permitted from your network. " +
          "Corporate networks, sandboxes and some mobile carriers block AI endpoints.",
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Sends a minimal real request, so auth and model name are both exercised. */
async function probeCompletion(
  config: Exclude<ProviderConfig, { kind: "deterministic" }>,
  timeoutMs: number,
  options: DiagnoseOptions,
): Promise<{ check: DiagnosticCheck; errorKind: ProviderErrorKind | null }> {
  const startedAt = Date.now();

  const isAnthropic = config.kind === "anthropic";
  const url = isAnthropic
    ? `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`
    : `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (config.apiKey.length > 0) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const body = isAnthropic
    ? {
        model: config.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }
    : {
        model: config.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      };

  try {
    const result = await postJson({
      provider: config.providerId,
      url,
      headers,
      body,
      timeoutMs,
      // One attempt: the diagnostic reports the failure, it does not mask it
      // behind retries that would make a persistent fault look intermittent.
      maxAttempts: 1,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });

    return {
      check: {
        stage: "completion",
        ok: true,
        detail: `The endpoint accepted the key and returned a completion in ${result.durationMs}ms.`,
        durationMs: Date.now() - startedAt,
      },
      errorKind: null,
    };
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(String(error), { kind: "network", provider: config.providerId });

    return {
      check: {
        stage: providerError.kind === "auth" ? "auth" : "completion",
        ok: false,
        detail: redactSecrets(providerError.message).slice(0, 400),
        hint: providerError.userMessage,
        durationMs: Date.now() - startedAt,
      },
      errorKind: providerError.kind,
    };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
