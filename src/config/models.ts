import type { Bindings } from "../types/env";

export type ProviderName = "gemini" | "groq" | "openrouter";
export type ModelAlias = "default" | "fast" | "gemini" | "groq" | "openrouter";
export type RoutingStrategy = "fallback_order" | "lowest_latency";

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  getKey: (env: Bindings) => string | undefined;
}

export interface GatewayConfig {
  providers: Record<ProviderName, ProviderConfig>;
  aliases: Record<ModelAlias, ProviderName[]>;
  strategy: RoutingStrategy;
  limits: {
    MAX_TOKENS_CAP: number;
    REQUEST_TIMEOUT_MS: number;
    MAX_CONTENT_LENGTH_BYTES: number;
    MAX_COMBINED_CONTENT_CHARS: number;
  };
}

export const gatewayConfig: GatewayConfig = {
  providers: {
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-flash-latest",
      getKey: (env) => env.GEMINI_API_KEY,
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-20b",
      getKey: (env) => env.GROQ_API_KEY,
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      getKey: (env) => env.OPENROUTER_API_KEY,
    },
  },
  aliases: {
    default: ["gemini", "groq", "openrouter"],
    fast: ["groq", "gemini", "openrouter"],
    gemini: ["gemini"],
    groq: ["groq"],
    openrouter: ["openrouter"],
  },
  strategy: "fallback_order",
  limits: {
    MAX_TOKENS_CAP: 1024,
    REQUEST_TIMEOUT_MS: 30000,
    MAX_CONTENT_LENGTH_BYTES: 100000,
    MAX_COMBINED_CONTENT_CHARS: 50000,
  },
};
