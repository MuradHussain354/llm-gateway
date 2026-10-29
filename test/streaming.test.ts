import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { v1Routes } from "../src/routes/v1";
import { sha256Hex } from "../src/lib/crypto";
import * as dbClient from "../src/db/client";
import type { AppEnv, Bindings } from "../src/types/env";
import type { ApiKey } from "../src/db/schema";

describe("Streaming Chat Completions & Request Logging", () => {
  let app: Hono<AppEnv>;
  let loggedRows: any[] = [];
  const rawClientApiKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const env: Bindings = {
    DB: {} as D1Database,
    GEMINI_API_KEY: "secret-gemini-key-12345",
    GROQ_API_KEY: "secret-groq-key-67890",
    OPENROUTER_API_KEY: "secret-openrouter-key-abcde",
  };

  beforeEach(async () => {
    loggedRows = [];
    vi.spyOn(console, "error").mockImplementation(() => {});

    const keyHash = await sha256Hex(rawClientApiKey);
    const validKey: ApiKey = {
      id: "key-stream-test",
      name: "Stream Test Client",
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
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val) => {
          loggedRows.push(val);
          return Promise.resolve();
        }),
      }),
    };
    vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

    app = new Hono<AppEnv>();
    app.use("/v1/*", authMiddleware);
    app.route("/v1", v1Routes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds stream_options only when stream: true", async () => {
    let capturedBodyStream: any;
    let capturedBodyNonStream: any;

    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const parsed = JSON.parse(init?.body as string);
      if (parsed.stream) {
        capturedBodyStream = parsed;
        return Promise.resolve(
          new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        );
      } else {
        capturedBodyNonStream = parsed;
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
    });

    // Request with stream: true
    await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawClientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
      },
      env
    );

    // Request with non-streaming
    await app.request(
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

    expect(capturedBodyStream.stream).toBe(true);
    expect(capturedBodyStream.stream_options).toEqual({ include_usage: true });

    expect(capturedBodyNonStream.stream).toBeUndefined();
    expect(capturedBodyNonStream.stream_options).toBeUndefined();
  });

  it("handles successful stream, isolates headers, and writes exactly 1 log row", async () => {
    const ssePayload =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":6,"completion_tokens":4}}\n\n' +
      "data: [DONE]\n\n";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(ssePayload, {
        status: 200,
        headers: new Headers({
          "Content-Type": "text/event-stream",
          "Set-Cookie": "secret_cookie=xyz",
          "X-Upstream-Header": "drop-me",
        }),
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
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("X-Gateway-Provider")).toBe("gemini");
    expect(res.headers.get("X-Gateway-Request-Id")).toBeDefined();
    expect(res.headers.get("X-Gateway-Latency-Ms")).toBeDefined();

    // Verify upstream headers dropped
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Upstream-Header")).toBeNull();

    // Consume stream body completely
    const text = await res.text();
    expect(text).toBe(ssePayload);

    // Exactly one log row written
    expect(loggedRows).toHaveLength(1);
    const row = loggedRows[0];
    expect(row.status).toBe(200);
    expect(row.provider).toBe("gemini");
    expect(row.model).toBe("gemini-flash-latest");
    expect(row.prompt_tokens).toBe(6);
    expect(row.completion_tokens).toBe(4);
    expect(row.usage_estimated).toBe(false);
    expect(row.error_type).toBeNull();

    // Never contain prompts or keys
    const rowJson = JSON.stringify(row);
    expect(rowJson).not.toContain("Hello");
    expect(rowJson).not.toContain(rawClientApiKey);
    expect(rowJson).not.toContain(env.GEMINI_API_KEY);
  });

  it("handles upstream 429 on stream: true by returning JSON error and logging 1 row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limit" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "25",
        },
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
          stream: true,
        }),
      },
      env
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("25");
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("rate_limit_exceeded");

    expect(loggedRows).toHaveLength(1);
    expect(loggedRows[0].status).toBe(429);
    expect(loggedRows[0].error_type).toBe("rate_limit_exceeded");
  });

  it("handles upstream 503 on stream: true by returning 502 Bad Gateway and logging 1 row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
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
          stream: true,
        }),
      },
      env
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as any;
    expect(json.error.message).toContain("Upstream provider unavailable");

    expect(loggedRows).toHaveLength(1);
    expect(loggedRows[0].status).toBe(502);
    expect(loggedRows[0].error_type).toBe("upstream_error");
  });

  it("handles non-streaming usage missing and sets usage_estimated = true in D1 log", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Answer" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
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
          messages: [{ role: "user", content: "Hello there" }],
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(loggedRows).toHaveLength(1);
    expect(loggedRows[0].usage_estimated).toBe(true);
    expect(loggedRows[0].prompt_tokens).toBe(Math.ceil("Hello there".length / 4));
    expect(loggedRows[0].completion_tokens).toBe(Math.ceil("Answer".length / 4));
  });

  it("resolves deferred waitUntil promise even if DB insert rejects (try/finally)", async () => {
    // Make DB insert throw an error
    const failingDb = {
      query: {
        apiKeys: {
          findFirst: vi.fn().mockResolvedValue({
            id: "key-stream-test",
            name: "Stream Test Client",
            key_hash: await sha256Hex(rawClientApiKey),
            key_prefix: "gw_01234",
            rpm_limit: 60,
            daily_token_quota: 100000,
            created_at: new Date(),
            revoked_at: null,
          }),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error("D1 internal failure")),
      }),
    };
    vi.spyOn(dbClient, "getDb").mockReturnValue(failingDb as unknown as dbClient.DbClient);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    let capturedWaitPromise: Promise<any> | null = null;
    const mockCtx = {
      waitUntil: (p: Promise<any>) => {
        capturedWaitPromise = p;
      },
    };

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
          stream: true,
        }),
      },
      env,
      mockCtx as any
    );

    expect(res.status).toBe(200);
    // Consume the stream so onDone fires
    await res.text();

    expect(capturedWaitPromise).not.toBeNull();
    // The deferred promise MUST resolve without throwing/hanging
    await expect(capturedWaitPromise).resolves.toBeUndefined();
  });

  describe("stream status mapping (200, 499, 502, 504)", () => {
    it("maps status to 499 on client_disconnect", async () => {
      let capturedWaitPromise: Promise<any> | null = null;
      const mockCtx = {
        waitUntil: (p: Promise<any>) => {
          capturedWaitPromise = p;
        },
      };

      const encoder = new TextEncoder();
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(readable, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
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
            stream: true,
          }),
        },
        env,
        mockCtx as any
      );

      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // Read first chunk
      await reader.cancel("Client disconnected"); // Cancel stream

      await capturedWaitPromise;

      expect(loggedRows).toHaveLength(1);
      expect(loggedRows[0].status).toBe(499);
      expect(loggedRows[0].error_type).toBe("client_disconnect");
    });

    it("maps status to 502 on upstream_stream_error (e.g. line buffer exceeded 1 MB)", async () => {
      let capturedWaitPromise: Promise<any> | null = null;
      const mockCtx = {
        waitUntil: (p: Promise<any>) => {
          capturedWaitPromise = p;
        },
      };

      const hugeLine = "data: " + "x".repeat(1024 * 1024 + 10);
      const encoder = new TextEncoder();
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(hugeLine));
        },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(readable, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
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
            stream: true,
          }),
        },
        env,
        mockCtx as any
      );

      expect(res.status).toBe(200);
      // Consuming stream should throw due to buffer limit
      await expect(res.text()).rejects.toThrow();

      await capturedWaitPromise;

      expect(loggedRows).toHaveLength(1);
      expect(loggedRows[0].status).toBe(502);
      expect(loggedRows[0].error_type).toBe("upstream_stream_error");
    });

    it("maps status to 504 on upstream_idle_timeout", async () => {
      vi.useFakeTimers();

      let capturedWaitPromise: Promise<any> | null = null;
      const mockCtx = {
        waitUntil: (p: Promise<any>) => {
          capturedWaitPromise = p;
        },
      };

      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(readable, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
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
            stream: true,
          }),
        },
        env,
        mockCtx as any
      );

      expect(res.status).toBe(200);
      const textPromise = res.text();
      const assertionPromise = expect(textPromise).rejects.toThrow();

      // Emit first chunk
      streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));

      // Advance timers past 30 seconds idle limit
      await vi.advanceTimersByTimeAsync(31000);

      await assertionPromise;
      await capturedWaitPromise;

      expect(loggedRows).toHaveLength(1);
      expect(loggedRows[0].status).toBe(504);
      expect(loggedRows[0].error_type).toBe("upstream_idle_timeout");

      vi.useRealTimers();
    });
  });
});
