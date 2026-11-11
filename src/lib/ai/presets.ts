/**
 * Known OpenAI-compatible endpoints.
 *
 * A preset only fills in a *default* base URL and model. Nothing here is
 * required: `MOTI_ANALYSIS_BASE_URL` always wins, so any compliant endpoint —
 * including one not listed — can be used.
 *
 * Models are defaults, not guarantees. Providers retire model names regularly,
 * so an invalid model surfaces as a clear `bad_request` error with the provider's
 * own message rather than a silent fallback.
 */

import type { ProviderId } from "./config";

export type EndpointPreset = {
  baseUrl: string;
  defaultModel: string;
  /** Link to where a key is issued, shown in setup instructions. */
  keyUrl: string;
  /** True when the endpoint typically runs locally and needs no key. */
  local?: boolean;
};

export const ENDPOINT_PRESETS: Record<
  Exclude<ProviderId, "anthropic" | "deterministic">,
  EndpointPreset
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  gemini: {
    // Google's OpenAI-compatibility layer.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyUrl: "https://api.together.xyz/settings/api-keys",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-3.5-sonnet",
    keyUrl: "https://openrouter.ai/keys",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1:8b",
    keyUrl: "https://ollama.com/download",
    local: true,
  },
  lmstudio: {
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    keyUrl: "https://lmstudio.ai",
    local: true,
  },
  "openai-compatible": {
    // Requires MOTI_ANALYSIS_BASE_URL; there is no sensible default.
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
  },
};
