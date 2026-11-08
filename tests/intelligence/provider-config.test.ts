import { describe, expect, it } from "vitest";
import {
  PROVIDER_IDS,
  ProviderConfigError,
  describeProvider,
  isGenerativeConfigured,
  providerFromConfig,
  readProviderConfig,
} from "@/lib/ai";

const CLEAN = {
  MOTI_ANALYSIS_PROVIDER: undefined,
  MOTI_ANALYSIS_MODEL: undefined,
  MOTI_ANALYSIS_BASE_URL: undefined,
  MOTI_ANALYSIS_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  MOTI_ANALYSIS_ALLOW_NO_KEY: undefined,
  MOTI_ANALYSIS_TIMEOUT_MS: undefined,
  MOTI_ANALYSIS_MAX_ATTEMPTS: undefined,
} as const;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...CLEAN, ...overrides } as unknown as NodeJS.ProcessEnv;
}

const KEY = "sk-test-" + "x".repeat(32);

describe("provider selection", () => {
  it("defaults to the deterministic engine", () => {
    const config = readProviderConfig(env());
    expect(config.kind).toBe("deterministic");
    expect(isGenerativeConfigured(env())).toBe(false);
  });

  it("requires no key at all for deterministic mode", () => {
    expect(() => readProviderConfig(env())).not.toThrow();
    const bundle = providerFromConfig(readProviderConfig(env()));
    expect(bundle.kind).toBe("deterministic");
  });

  it("rejects an unknown provider instead of silently degrading", () => {
    expect(() => readProviderConfig(env({ MOTI_ANALYSIS_PROVIDER: "not-a-provider" }))).toThrow(
      ProviderConfigError,
    );
  });

  it("lists every supported provider id", () => {
    for (const id of PROVIDER_IDS) {
      expect(typeof id).toBe("string");
    }
    expect(PROVIDER_IDS).toContain("anthropic");
    expect(PROVIDER_IDS).toContain("openai");
    expect(PROVIDER_IDS).toContain("gemini");
    expect(PROVIDER_IDS).toContain("openrouter");
    expect(PROVIDER_IDS).toContain("ollama");
  });
});

describe("anthropic configuration", () => {
  it("fails fast when the key is missing", () => {
    expect(() => readProviderConfig(env({ MOTI_ANALYSIS_PROVIDER: "anthropic" }))).toThrow(
      /MOTI_ANALYSIS_API_KEY/,
    );
  });

  it("accepts the new generic key variable", () => {
    const config = readProviderConfig(
      env({ MOTI_ANALYSIS_PROVIDER: "anthropic", MOTI_ANALYSIS_API_KEY: KEY }),
    );

    expect(config.kind).toBe("anthropic");
    if (config.kind === "anthropic") {
      expect(config.apiKey).toBe(KEY);
      expect(config.baseUrl).toBe("https://api.anthropic.com");
    }
  });

  it("still honours the legacy ANTHROPIC_API_KEY", () => {
    const config = readProviderConfig(
      env({ MOTI_ANALYSIS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }),
    );
    expect(config.kind).toBe("anthropic");
  });

  it("uses the configured model, falling back to a default", () => {
    const withModel = readProviderConfig(
      env({
        MOTI_ANALYSIS_PROVIDER: "anthropic",
        MOTI_ANALYSIS_API_KEY: KEY,
        MOTI_ANALYSIS_MODEL: "claude-opus-4-1",
      }),
    );
    expect(withModel.kind === "anthropic" && withModel.model).toBe("claude-opus-4-1");

    const withoutModel = readProviderConfig(
      env({ MOTI_ANALYSIS_PROVIDER: "anthropic", MOTI_ANALYSIS_API_KEY: KEY }),
    );
    expect(withoutModel.kind === "anthropic" && withoutModel.model).toMatch(/^claude-/);
  });
});

describe("openai-compatible configuration", () => {
  it("fills the base URL and model from a preset", () => {
    const config = readProviderConfig(
      env({ MOTI_ANALYSIS_PROVIDER: "groq", MOTI_ANALYSIS_API_KEY: KEY }),
    );

    expect(config.kind).toBe("openai-compatible");
    if (config.kind === "openai-compatible") {
      expect(config.baseUrl).toBe("https://api.groq.com/openai/v1");
      expect(config.model).toBeTruthy();
      expect(config.providerId).toBe("groq");
    }
  });

  it("lets an explicit base URL override the preset", () => {
    const config = readProviderConfig(
      env({
        MOTI_ANALYSIS_PROVIDER: "openai",
        MOTI_ANALYSIS_API_KEY: KEY,
        MOTI_ANALYSIS_BASE_URL: "https://my-gateway.example.com/v1",
      }),
    );
    expect(config.kind === "openai-compatible" && config.baseUrl).toBe(
      "https://my-gateway.example.com/v1",
    );
  });

  it("requires a base URL for the generic provider", () => {
    expect(() =>
      readProviderConfig(
        env({ MOTI_ANALYSIS_PROVIDER: "openai-compatible", MOTI_ANALYSIS_API_KEY: KEY }),
      ),
    ).toThrow(/MOTI_ANALYSIS_BASE_URL/);
  });

  it("requires a key for hosted providers", () => {
    expect(() => readProviderConfig(env({ MOTI_ANALYSIS_PROVIDER: "openai" }))).toThrow(
      /MOTI_ANALYSIS_API_KEY/,
    );
  });

  it("allows a keyless local runtime", () => {
    const config = readProviderConfig(env({ MOTI_ANALYSIS_PROVIDER: "ollama" }));
    expect(config.kind).toBe("openai-compatible");
    if (config.kind === "openai-compatible") {
      expect(config.allowNoKey).toBe(true);
      expect(config.baseUrl).toMatch(/localhost/);
    }
  });

  it("allows keyless when explicitly permitted", () => {
    const config = readProviderConfig(
      env({
        MOTI_ANALYSIS_PROVIDER: "openai",
        MOTI_ANALYSIS_ALLOW_NO_KEY: "true",
      }),
    );
    expect(config.kind === "openai-compatible" && config.allowNoKey).toBe(true);
  });

  it("rejects an invalid timeout rather than using it", () => {
    expect(() =>
      readProviderConfig(
        env({
          MOTI_ANALYSIS_PROVIDER: "openai",
          MOTI_ANALYSIS_API_KEY: KEY,
          MOTI_ANALYSIS_TIMEOUT_MS: "-5",
        }),
      ),
    ).toThrow(/timeout/i);
  });

  it("builds a provider whose identity records the vendor, not a generic name", () => {
    const bundle = providerFromConfig(
      readProviderConfig(env({ MOTI_ANALYSIS_PROVIDER: "mistral", MOTI_ANALYSIS_API_KEY: KEY })),
    );

    expect(bundle.kind).toBe("generative");
    if (bundle.kind === "generative") {
      expect(bundle.provider.identity.provider).toBe("mistral");
      expect(bundle.provider.isGenerative).toBe(true);
    }
  });
});

describe("provider summary (safe for the UI)", () => {
  it("never contains the API key", () => {
    const summary = describeProvider(
      env({ MOTI_ANALYSIS_PROVIDER: "openai", MOTI_ANALYSIS_API_KEY: KEY }),
    );

    expect(summary.hasApiKey).toBe(true);
    // The serialised summary must not leak the secret anywhere.
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });

  it("reports a configuration error instead of throwing", () => {
    const summary = describeProvider(env({ MOTI_ANALYSIS_PROVIDER: "openai" }));
    expect(summary.configured).toBe(false);
    expect(summary.error).toMatch(/MOTI_ANALYSIS_API_KEY/);
  });

  it("marks deterministic as not generative", () => {
    const summary = describeProvider(env());
    expect(summary.isGenerative).toBe(false);
    expect(summary.provider).toBe("deterministic");
  });

  it("does not throw for an unknown provider", () => {
    const summary = describeProvider(env({ MOTI_ANALYSIS_PROVIDER: "nonsense" }));
    expect(summary.configured).toBe(false);
    expect(summary.provider).toBe("unknown");
  });
});
