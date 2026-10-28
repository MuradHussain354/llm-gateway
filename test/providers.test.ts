import { describe, it, expect, vi, afterEach } from "vitest";
import { providers } from "../src/providers";
import type { Bindings } from "../src/types/env";
import type { ChatCompletionRequest } from "../src/providers/types";

describe("Provider Adapters (src/providers/index.ts)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const env: Bindings = {
    DB: {} as D1Database,
    GEMINI_API_KEY: "test-gemini-key",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
  };

  const sampleRequest: ChatCompletionRequest = {
    model: "default",
    messages: [{ role: "user", content: "Tell me a joke" }],
    temperature: 0.7,
  };

  it("checks isConfigured accurately", () => {
    expect(providers.gemini.isConfigured(env)).toBe(true);
    expect(providers.gemini.isConfigured({ ...env, GEMINI_API_KEY: undefined })).toBe(false);
    expect(providers.gemini.isConfigured({ ...env, GEMINI_API_KEY: "   " })).toBe(false);
  });

  it("calls Gemini with correct URL, header, and replaced model", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ choices: [] })));
    });

    const signal = new AbortController().signal;
    await providers.gemini.chat(sampleRequest, env, signal);

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-gemini-key"
    );

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe("gemini-flash-latest");
    expect(body.messages[0].content).toBe("Tell me a joke");
  });

  it("calls Groq with correct URL, header, and replaced model", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ choices: [] })));
    });

    const signal = new AbortController().signal;
    await providers.groq.chat(sampleRequest, env, signal);

    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-groq-key"
    );

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe("openai/gpt-oss-20b");
  });

  it("calls OpenRouter with correct URL, header, and replaced model", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ choices: [] })));
    });

    const signal = new AbortController().signal;
    await providers.openrouter.chat(sampleRequest, env, signal);

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-openrouter-key"
    );

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe("openrouter/free");
  });

  it("passes response body through unchanged including reasoning content", async () => {
    const upstreamPayload = {
      id: "chatcmpl-test",
      choices: [
        {
          message: {
            role: "assistant",
            content: "The answer is 42.",
            reasoning_content: "Step 1: Computed 6 * 7. Step 2: Concluded 42.",
          },
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(upstreamPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const signal = new AbortController().signal;
    const response = await providers.gemini.chat(sampleRequest, env, signal);
    const data = await response.json();

    expect(data).toEqual(upstreamPayload);
  });
});
