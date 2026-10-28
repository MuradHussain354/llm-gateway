import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { v1Routes } from "../src/routes/v1";
import { sha256Hex } from "../src/lib/crypto";
import * as dbClient from "../src/db/client";
import type { AppEnv, Bindings } from "../src/types/env";
import type { ApiKey } from "../src/db/schema";

describe("POST /v1/chat/completions", () => {
  let app: Hono<AppEnv>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const rawClientApiKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const env: Bindings = {
    DB: {} as D1Database,
    GEMINI_API_KEY: "secret-gemini-key-12345",
    GROQ_API_KEY: "secret-groq-key-67890",
    OPENROUTER_API_KEY: "secret-openrouter-key-abcde",
  };

  beforeEach(async () => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const keyHash = await sha256Hex(rawClientApiKey);
    const validKey: ApiKey = {
      id: "key-chat-test",
      name: "Test Client",
      key_hash: keyHash,
      key_prefix: "gw_01234",
      rpm_limit: 60,
      daily_token_quota: 100000,
      created_at: new Date(),
      revoked_at: null,
    };

    const mockDb = {
      query: {
        apiKeys: {
          findFirst: vi.fn().mockResolvedValue(validKey),
        },
      },
    };
    vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

    app = new Hono<AppEnv>();
    app.use("/v1/*", authMiddleware);
    app.route("/v1", v1Routes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully routes to provider, returns 200, and sets custom gateway headers", async () => {
    const upstreamJson = {
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "Hello there!" } }],
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(upstreamJson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gateway-Provider")).toBe("gemini");
    expect(res.headers.get("X-Gateway-Latency-Ms")).toBeDefined();
    const body = (await res.json()) as any;
    expect(body).toEqual(upstreamJson);
  });

  it("strips all upstream headers (set-cookie, x-request-id, content-encoding) and builds a new Response", async () => {
    const upstreamHeaders = new Headers({
      "Content-Type": "application/json",
      "Set-Cookie": "session=abc; Path=/",
      "X-Request-Id": "upstream-req-999",
      "Content-Encoding": "gzip",
      "Server": "cloudflare",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: upstreamHeaders,
      })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    // Preserved headers:
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Gateway-Provider")).toBe("gemini");
    expect(res.headers.get("X-Gateway-Latency-Ms")).toBeDefined();

    // Stripped upstream headers:
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Request-Id")).toBeNull();
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Server")).toBeNull();
  });

  it("maps DOMException 'TimeoutError' to 504", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError")
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("gateway_timeout");
    expect(body.error.message).toContain("timed out");
    expect(res.headers.get("X-Gateway-Provider")).toBe("gemini");

    // Check logged content
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Upstream provider error: provider=gemini, status=504, error_type=timeout"
    );
  });

  it("maps DOMException 'AbortError' to 504", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The user aborted a request.", "AbortError")
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("gateway_timeout");
  });

  it("maps upstream 429 to 429 and preserves Retry-After header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limit" }), {
        status: 429,
        headers: { "Retry-After": "15" },
      })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("15");
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Upstream provider error: provider=gemini, status=429, error_type=rate_limit_exceeded"
    );
  });

  it("maps upstream 500 and 503 to 502 with normalized OpenAI error format", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error from upstream", { status: 503 })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("Upstream provider unavailable or returned server error.");
    expect(body.error.code).toBe("bad_gateway");
    // Raw upstream text must not leak to response
    expect(JSON.stringify(body)).not.toContain("Internal Server Error from upstream");
  });

  it("maps upstream 4xx (e.g. 400) to 502 with generic message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ secret_provider_details: "internal leak" }), { status: 400 })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.message).toBe("Upstream provider rejected the request.");
    expect(JSON.stringify(body)).not.toContain("secret_provider_details");
  });

  it("rejects Content-Length > 100000 with 413", async () => {
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
          "Content-Length": "100005",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("request_too_large");
  });

  it("rejects combined message content > 50000 characters with 400", async () => {
    const longMessage = "x".repeat(50001);
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: longMessage.slice(0, 20000) },
            { role: "assistant", content: longMessage.slice(20000, 40000) },
            { role: "user", content: longMessage.slice(40000, 50001) },
          ],
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("content_length_exceeded");
  });

  it("proves NO provider API key appears anywhere in error responses or headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Something bad happened" }), { status: 500 })
    );

    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
      env
    );

    const resBody = await res.text();
    const resHeaders = JSON.stringify(Array.from(res.headers.entries()));

    // Assert keys are NEVER present in response body or headers
    expect(resBody).not.toContain(env.GEMINI_API_KEY);
    expect(resBody).not.toContain(env.GROQ_API_KEY);
    expect(resBody).not.toContain(env.OPENROUTER_API_KEY);

    expect(resHeaders).not.toContain(env.GEMINI_API_KEY);
    expect(resHeaders).not.toContain(env.GROQ_API_KEY);
    expect(resHeaders).not.toContain(env.OPENROUTER_API_KEY);
  });
});
