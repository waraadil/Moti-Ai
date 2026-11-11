/**
 * Connectivity diagnostic tests.
 *
 * The diagnostic exists to separate three failures people conflate:
 * a network block, a bad key, and a bad model name. Each is asserted here.
 */

import { describe, expect, it } from "vitest";
import { diagnoseProvider } from "@/lib/ai/diagnose";
import { createMockFetch, openAiResponse } from "../helpers/mock-provider";

const KEY = "sk-test-" + "q".repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    MOTI_ANALYSIS_PROVIDER: undefined,
    MOTI_ANALYSIS_API_KEY: undefined,
    MOTI_ANALYSIS_BASE_URL: undefined,
    MOTI_ANALYSIS_MODEL: undefined,
    MOTI_ANALYSIS_ALLOW_NO_KEY: undefined,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

describe("diagnoseProvider", () => {
  it("reports deterministic mode without any network call", async () => {
    const report = await diagnoseProvider({ source: env() });

    expect(report.ok).toBe(true);
    expect(report.isGenerative).toBe(false);
    expect(report.checks).toHaveLength(1);
    // Must be explicit that this is not a language model.
    expect(report.checks[0]?.hint).toMatch(/not a language model/i);
  });

  it("reports a configuration error without throwing", async () => {
    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "openai" }),
    });

    expect(report.ok).toBe(false);
    expect(report.errorKind).toBe("config");
    expect(report.checks[0]?.stage).toBe("config");
    expect(report.checks[0]?.detail).toMatch(/MOTI_ANALYSIS_API_KEY/);
  });

  it("identifies an unreachable endpoint as a network failure, not a key problem", async () => {
    const mock = createMockFetch([{ kind: "throw", error: new Error("ENOTFOUND") }]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
      skipCompletion: true,
    });

    expect(report.ok).toBe(false);
    expect(report.errorKind).toBe("network");

    const reachability = report.checks.find((check) => check.stage === "reachability");
    expect(reachability?.ok).toBe(false);
    expect(reachability?.hint).toMatch(/network problem, not a code or key problem/i);
  });

  it("treats any HTTP response as reachable, even a 4xx", async () => {
    // A bare GET to an API root often returns 404/401; that still proves TLS works.
    const mock = createMockFetch([{ kind: "json", status: 404, body: {} }]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
      skipCompletion: true,
    });

    const reachability = report.checks.find((check) => check.stage === "reachability");
    expect(reachability?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("distinguishes a rejected key from a network failure", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 200, body: {} }, // reachability
      { kind: "json", status: 401, body: { error: "invalid api key" } }, // completion
    ]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.errorKind).toBe("auth");

    const auth = report.checks.find((check) => check.stage === "auth");
    expect(auth?.ok).toBe(false);
    expect(auth?.hint).toMatch(/key was rejected/i);
  });

  it("passes when the endpoint accepts the key and returns a completion", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 200, body: {} },
      { kind: "json", body: openAiResponse("ok") },
    ]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.errorKind).toBeNull();
    expect(report.checks.map((check) => check.stage)).toEqual([
      "config",
      "reachability",
      "completion",
    ]);
  });

  it("reports a bad model name separately from auth", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 200, body: {} },
      { kind: "json", status: 404, body: { error: "model not found" } },
    ]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.errorKind).toBe("bad_request");
  });

  it("never includes the API key in any field of the report", async () => {
    const mock = createMockFetch([
      { kind: "json", status: 200, body: {} },
      { kind: "text", status: 400, body: `Bad key: ${KEY}` },
    ]);

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: mock.fetchImpl,
    });

    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("reports a timeout as a reachability failure", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;

    const report = await diagnoseProvider({
      source: env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
      fetchImpl: hanging,
      timeoutMs: 30,
      skipCompletion: true,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.stage === "reachability")?.detail).toMatch(
      /timed out/i,
    );
  });
});
