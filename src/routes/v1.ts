import { Hono } from "hono";
import { gatewayConfig, type ModelAlias } from "../config/models";
import { openAiError } from "../lib/errors";
import { getSafeExecutionCtx, queueRequestLog } from "../lib/logging";
import { createSseTransform } from "../lib/sse";
import { validateChatCompletionRequest } from "../lib/validation";
import { recordLatency, resolveProvider } from "../router";
import type { AppEnv } from "../types/env";

const v1Routes = new Hono<AppEnv>();

// GET /v1/me - test authentication
v1Routes.get("/me", (c) => {
  const apiKey = c.get("apiKey");
  return c.json({
    name: apiKey.name,
    key_prefix: apiKey.key_prefix,
  });
});

// POST /v1/chat/completions - streaming and non-streaming completions
v1Routes.post("/chat/completions", async (c) => {
  const requestId = crypto.randomUUID();
  const apiKeyId = c.get("apiKey")?.id ?? null;
  const contentLength = c.req.header("Content-Length");

  // 1. Request size limit check
  if (contentLength) {
    const lengthNum = parseInt(contentLength, 10);
    if (!isNaN(lengthNum) && lengthNum > gatewayConfig.limits.MAX_CONTENT_LENGTH_BYTES) {
      return openAiError(
        c,
        413,
        `Request entity too large. Maximum allowed Content-Length is ${gatewayConfig.limits.MAX_CONTENT_LENGTH_BYTES} bytes.`,
        "invalid_request_error",
        "request_too_large"
      );
    }
  }

  // 2. Parse JSON
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return openAiError(
      c,
      400,
      "Invalid JSON in request body.",
      "invalid_request_error",
      "invalid_payload"
    );
  }

  // 3. Validate request schema and limits
  const validation = validateChatCompletionRequest(contentLength, rawBody);
  if (!validation.success || !validation.data) {
    const err = validation.error!;
    return openAiError(c, err.status, err.message, err.type, err.code);
  }

  const reqData = validation.data;
  const isStream = reqData.stream === true;
  const totalPromptChars = reqData.messages.reduce(
    (acc, m) => acc + m.content.length,
    0
  );

  // 4. Route to provider
  const resolution = resolveProvider(reqData.model as ModelAlias, c.env);
  if (resolution.error || !resolution.provider) {
    const err = resolution.error!;
    return openAiError(c, err.status, err.message, err.type, err.code);
  }

  const provider = resolution.provider;
  const startTime = performance.now();

  // 5. Upstream Fetch Execution
  const upstreamAbortController = new AbortController();
  let headerTimeoutId: ReturnType<typeof setTimeout> | null = null;

  headerTimeoutId = setTimeout(() => {
    upstreamAbortController.abort(new DOMException("Header timeout", "TimeoutError"));
  }, gatewayConfig.limits.REQUEST_TIMEOUT_MS);

  let upstreamRes: Response;
  try {
    upstreamRes = await provider.chat(reqData, c.env, upstreamAbortController.signal);
  } catch (err: unknown) {
    clearTimeout(headerTimeoutId);
    const latencyMs = Math.round(performance.now() - startTime);
    recordLatency(provider.name, latencyMs);

    const errorName = err instanceof Error ? err.name : "";
    const isTimeout = errorName === "TimeoutError" || errorName === "AbortError";
    const status = isTimeout ? 504 : 502;
    const errorType = isTimeout ? "timeout" : "network_error";

    console.error(
      `Upstream provider error: provider=${provider.name}, status=${status}, error_type=${errorType}`
    );

    await queueRequestLog(c, {
      id: requestId,
      api_key_id: apiKeyId,
      provider: provider.name,
      model: provider.model,
      status,
      latency_ms: latencyMs,
      prompt_tokens: Math.ceil(totalPromptChars / 4),
      completion_tokens: 0,
      usage_estimated: true,
      cache_hit: false,
      error_type: errorType,
      created_at: new Date(),
    });

    c.header("X-Gateway-Provider", provider.name);
    c.header("X-Gateway-Request-Id", requestId);
    c.header("X-Gateway-Latency-Ms", latencyMs.toString());

    if (isTimeout) {
      return openAiError(
        c,
        504,
        "Upstream request timed out.",
        "api_error",
        "gateway_timeout"
      );
    }

    return openAiError(
      c,
      502,
      "Failed to connect to upstream provider.",
      "api_error",
      "bad_gateway"
    );
  }

  // Headers have arrived: clear the initial header timeout
  clearTimeout(headerTimeoutId);
  const ttfbMs = Math.round(performance.now() - startTime);

  // 6. Upstream Failure / Non-Streaming Error Handling
  const contentType = upstreamRes.headers.get("Content-Type") || "";
  const isUpstreamSuccess = upstreamRes.ok;
  const isStreamValid = isStream && isUpstreamSuccess && contentType.includes("text/event-stream");

  if (!isStreamValid && (!isUpstreamSuccess || isStream)) {
    const latencyMs = Math.round(performance.now() - startTime);
    recordLatency(provider.name, latencyMs);

    const upstreamStatus = upstreamRes.status;
    const errorType = upstreamStatus === 429 ? "rate_limit_exceeded" : "upstream_error";

    console.error(
      `Upstream provider error: provider=${provider.name}, status=${upstreamStatus}, error_type=${errorType}`
    );

    await queueRequestLog(c, {
      id: requestId,
      api_key_id: apiKeyId,
      provider: provider.name,
      model: provider.model,
      status: upstreamStatus === 429 ? 429 : 502,
      latency_ms: latencyMs,
      prompt_tokens: Math.ceil(totalPromptChars / 4),
      completion_tokens: 0,
      usage_estimated: true,
      cache_hit: false,
      error_type: errorType,
      created_at: new Date(),
    });

    c.header("X-Gateway-Provider", provider.name);
    c.header("X-Gateway-Request-Id", requestId);
    c.header("X-Gateway-Latency-Ms", latencyMs.toString());

    if (upstreamStatus === 429) {
      const retryAfter = upstreamRes.headers.get("Retry-After");
      if (retryAfter) {
        c.header("Retry-After", retryAfter);
      }
      return openAiError(
        c,
        429,
        "Rate limit exceeded on upstream provider.",
        "requests",
        "rate_limit_exceeded"
      );
    }

    if (upstreamStatus === 503 || upstreamStatus >= 500) {
      return openAiError(
        c,
        502,
        "Upstream provider unavailable or returned server error.",
        "api_error",
        "bad_gateway"
      );
    }

    return openAiError(
      c,
      502,
      "Upstream provider rejected the request.",
      "api_error",
      "bad_gateway"
    );
  }

  // 7. Streaming Path
  if (isStream) {
    let resolveStreamLog!: () => void;
    const streamLogPromise = new Promise<void>((resolve) => {
      resolveStreamLog = resolve;
    });

    const ctx = getSafeExecutionCtx(c);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(streamLogPromise);
    }

    const transformStream = createSseTransform({
      totalPromptChars,
      upstreamAbortController,
      onDone: async (result) => {
        try {
          const totalDuration = Math.round(performance.now() - startTime);
          recordLatency(provider.name, totalDuration);

          let streamStatus = 200;
          if (result.error_type) {
            switch (result.error_type) {
              case "client_disconnect":
                streamStatus = 499;
                break;
              case "upstream_stream_error":
                streamStatus = 502;
                break;
              case "upstream_idle_timeout":
                streamStatus = 504;
                break;
              default:
                streamStatus = 500;
            }
          }

          await queueRequestLog(c, {
            id: requestId,
            api_key_id: apiKeyId,
            provider: provider.name,
            model: provider.model,
            status: streamStatus,
            latency_ms: totalDuration,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            usage_estimated: result.usage_estimated,
            cache_hit: false,
            error_type: result.error_type,
            created_at: new Date(),
          });
        } finally {
          resolveStreamLog();
        }
      },
    });

    const streamBody = upstreamRes.body ? upstreamRes.body.pipeThrough(transformStream) : null;

    return new Response(streamBody, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Gateway-Provider": provider.name,
        "X-Gateway-Request-Id": requestId,
        "X-Gateway-Latency-Ms": ttfbMs.toString(),
      },
    });
  }

  // 8. Non-Streaming Success Path
  const latencyMs = Math.round(performance.now() - startTime);
  recordLatency(provider.name, latencyMs);

  const responseText = await upstreamRes.text();

  let promptTokens = Math.ceil(totalPromptChars / 4);
  let completionTokens = 0;
  let usageEstimated = true;

  try {
    const json = JSON.parse(responseText);
    if (json.usage && typeof json.usage.prompt_tokens === "number") {
      promptTokens = json.usage.prompt_tokens;
      completionTokens = typeof json.usage.completion_tokens === "number" ? json.usage.completion_tokens : 0;
      usageEstimated = false;
    } else {
      promptTokens = Math.ceil(totalPromptChars / 4);
      const content = json.choices?.[0]?.message?.content;
      completionTokens = Math.ceil((typeof content === "string" ? content.length : 0) / 4);
      usageEstimated = true;
    }
  } catch {
    // Fall back to estimated tokens
  }

  await queueRequestLog(c, {
    id: requestId,
    api_key_id: apiKeyId,
    provider: provider.name,
    model: provider.model,
    status: 200,
    latency_ms: latencyMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    usage_estimated: usageEstimated,
    cache_hit: false,
    error_type: null,
    created_at: new Date(),
  });

  return new Response(responseText, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Provider": provider.name,
      "X-Gateway-Request-Id": requestId,
      "X-Gateway-Latency-Ms": latencyMs.toString(),
    },
  });
});

export { v1Routes };
