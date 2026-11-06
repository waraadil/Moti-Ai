import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvValidationError,
  getPublicEnv,
  isPublicEnvConfigured,
  __resetPublicEnvCacheForTests,
} from "@/lib/env/public";

const VALID = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example-project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "a".repeat(40),
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("public environment validation", () => {
  beforeEach(() => {
    __resetPublicEnvCacheForTests();
    setEnv(VALID);
  });

  afterEach(() => {
    __resetPublicEnvCacheForTests();
    setEnv({
      ...VALID,
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    });
  });

  it("returns validated values when everything is present", () => {
    const env = getPublicEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(VALID.NEXT_PUBLIC_SUPABASE_URL);
  });

  it("defaults the app URL when it is not set", () => {
    setEnv({ NEXT_PUBLIC_APP_URL: undefined });
    __resetPublicEnvCacheForTests();
    expect(getPublicEnv().NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("throws a descriptive error naming the missing variable", () => {
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined });
    __resetPublicEnvCacheForTests();

    expect(() => getPublicEnv()).toThrow(EnvValidationError);
    try {
      getPublicEnv();
    } catch (error) {
      expect((error as EnvValidationError).issues.join(" ")).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect((error as Error).message).toContain("Copy .env.example to .env.local");
    }
  });

  it("rejects a malformed URL instead of silently accepting it", () => {
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" });
    __resetPublicEnvCacheForTests();
    expect(() => getPublicEnv()).toThrow(EnvValidationError);
  });

  it("rejects an implausibly short anon key", () => {
    setEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "short" });
    __resetPublicEnvCacheForTests();
    expect(() => getPublicEnv()).toThrow(EnvValidationError);
  });

  it("reports readiness without throwing for UI banners", () => {
    expect(isPublicEnvConfigured()).toBe(true);
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined });
    expect(isPublicEnvConfigured()).toBe(false);
  });

  it("never exposes a service role key through the public accessor", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-value-that-must-not-leak";
    __resetPublicEnvCacheForTests();
    const env = getPublicEnv();
    expect(JSON.stringify(env)).not.toContain("service-role-secret");
  });
});
