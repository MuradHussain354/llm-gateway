import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveProvider,
  recordLatency,
  resetLatencyStats,
} from "../src/router";
import type { Bindings } from "../src/types/env";

describe("Router module (src/router.ts)", () => {
  beforeEach(() => {
    resetLatencyStats();
  });

  const allConfiguredEnv: Bindings = {
    DB: {} as D1Database,
    GEMINI_API_KEY: "gemini-key",
    GROQ_API_KEY: "groq-key",
    OPENROUTER_API_KEY: "openrouter-key",
  };

  it("selects first configured provider for 'default' in fallback_order", () => {
    // "default" is ["gemini", "groq", "openrouter"]
    const res = resolveProvider("default", allConfiguredEnv, "fallback_order");
    expect(res.provider?.name).toBe("gemini");
  });

  it("selects first configured provider for 'fast' in fallback_order", () => {
    // "fast" is ["groq", "gemini", "openrouter"]
    const res = resolveProvider("fast", allConfiguredEnv, "fallback_order");
    expect(res.provider?.name).toBe("groq");
  });

  it("forces single provider when specific alias is requested", () => {
    expect(resolveProvider("gemini", allConfiguredEnv).provider?.name).toBe("gemini");
    expect(resolveProvider("groq", allConfiguredEnv).provider?.name).toBe("groq");
    expect(resolveProvider("openrouter", allConfiguredEnv).provider?.name).toBe("openrouter");
  });

  it("skips unconfigured providers in fallback order", () => {
    // Gemini key missing, Groq key present
    const env: Bindings = {
      DB: {} as D1Database,
      GEMINI_API_KEY: undefined,
      GROQ_API_KEY: "groq-key",
      OPENROUTER_API_KEY: "openrouter-key",
    };

    const res = resolveProvider("default", env, "fallback_order");
    expect(res.provider?.name).toBe("groq");
  });

  it("returns 503 when all candidate providers are unconfigured", () => {
    const unconfiguredEnv: Bindings = {
      DB: {} as D1Database,
      GEMINI_API_KEY: "",
      GROQ_API_KEY: "   ",
      OPENROUTER_API_KEY: undefined,
    };

    const res = resolveProvider("default", unconfiguredEnv);
    expect(res.provider).toBeUndefined();
    expect(res.error?.status).toBe(503);
    expect(res.error?.code).toBe("service_unavailable");
    expect(res.error?.message).toContain("No configured providers available for model 'default'");
  });

  it("routes based on lowest_latency strategy", () => {
    // Record rolling average latencies:
    // Gemini: 300ms, Groq: 150ms, OpenRouter: 500ms
    recordLatency("gemini", 300);
    recordLatency("groq", 150);
    recordLatency("openrouter", 500);

    const res = resolveProvider("default", allConfiguredEnv, "lowest_latency");
    expect(res.provider?.name).toBe("groq");
  });
});
