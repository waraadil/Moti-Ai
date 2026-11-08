import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerEnv, __resetServerEnvCacheForTests } from "@/lib/env/server";
import { EnvValidationError } from "@/lib/env/public";
import { readProviderSelection, createProvider, isGenerativeConfigured } from "@/lib/ai";

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const KEYS = [
  "MOTI_ANALYSIS_PROVIDER",
  "MOTI_ANALYSIS_MODEL",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

describe("analysis provider configuration", () => {
  beforeEach(() => {
    __resetServerEnvCacheForTests();
    setEnv(Object.fromEntries(KEYS.map((key) => [key, undefined])));
  });

  afterEach(() => {
    __resetServerEnvCacheForTests();
    setEnv(Object.fromEntries(KEYS.map((key) => [key, undefined])));
  });

  it("defaults to the offline deterministic engine", () => {
    const env = getServerEnv();
    expect(env.MOTI_ANALYSIS_PROVIDER).toBe("deterministic");
    expect(readProviderSelection().kind).toBe("deterministic");
  });

  it("allows the deterministic engine with no API key at all", () => {
    setEnv({ MOTI_ANALYSIS_PROVIDER: "deterministic" });
    __resetServerEnvCacheForTests();

    expect(() => getServerEnv()).not.toThrow();
    expect(createProvider().kind).toBe("deterministic");
    expect(isGenerativeConfigured()).toBe(false);
  });

  it("fails fast when anthropic is selected without a key", () => {
    setEnv({ MOTI_ANALYSIS_PROVIDER: "anthropic" });
    __resetServerEnvCacheForTests();

    expect(() => getServerEnv()).toThrow(EnvValidationError);
    try {
      getServerEnv();
    } catch (error) {
      expect((error as EnvValidationError).issues.join(" ")).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("builds an anthropic provider once a key is present", () => {
    setEnv({
      MOTI_ANALYSIS_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(40),
      MOTI_ANALYSIS_MODEL: "claude-sonnet-4-5-20250929",
    });
    __resetServerEnvCacheForTests();

    const bundle = createProvider();
    expect(bundle.kind).toBe("anthropic");
    expect(isGenerativeConfigured()).toBe(true);
  });

  it("rejects an unknown provider name instead of silently falling back", () => {
    setEnv({ MOTI_ANALYSIS_PROVIDER: "openai" });
    __resetServerEnvCacheForTests();

    expect(() => getServerEnv()).toThrow(EnvValidationError);
  });

  it("never requires the service role key just to analyse", () => {
    __resetServerEnvCacheForTests();
    expect(getServerEnv().SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
