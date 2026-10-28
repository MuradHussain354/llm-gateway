import { Hono } from "hono";
import { gatewayConfig, type ModelAlias } from "../config/models";
import { openAiError } from "../lib/errors";
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

// POST /v1/chat/completions - non-streaming chat completions
v1Routes.post("/chat/completions", async (c) => {
  const contentLength = c.req.header("Content-Length");

  // Request size limit check
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

  // Parse JSON
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

  // Validate request schema and limits
  const validation = validateChatCompletionRequest(contentLength, rawBody);
  if (!validation.success || !validation.data) {
    const err = validation.error!;
    return openAiError(c, err.status, err.message, err.type, err.code);
  }

  // Route to provider
  const resolution = resolveProvider(
    validation.data.model as ModelAlias,
    c.env
  );

  if (resolution.error || !resolution.provider) {
    const err = resolution.error!;
    return openAiError(c, err.status, err.message, err.type, err.code);
  }

  const provider = resolution.provider;
  const signal = AbortSignal.timeout(gatewayConfig.limits.REQUEST_TIMEOUT_MS);
  const startTime = performance.now();

  let upstreamRes: Response;
  try {
    upstreamRes = await provider.chat(validation.data, c.env, signal);
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - startTime);
    recordLatency(provider.name, latencyMs);

    const errorName = err instanceof Error ? err.name : "";
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      // Log only provider name, status and error type
      console.error(
        `Upstream provider error: provider=${provider.name}, status=504, error_type=timeout`
      );
      c.header("X-Gateway-Provider", provider.name);
      c.header("X-Gateway-Latency-Ms", latencyMs.toString());
      return openAiError(
        c,
        504,
        "Upstream request timed out.",
        "api_error",
        "gateway_timeout"
      );
    }

    console.error(
      `Upstream provider error: provider=${provider.name}, status=502, error_type=network_error`
    );
    c.header("X-Gateway-Provider", provider.name);
    c.header("X-Gateway-Latency-Ms", latencyMs.toString());
    return openAiError(
      c,
      502,
      "Failed to connect to upstream provider.",
      "api_error",
      "bad_gateway"
    );
  }

  const latencyMs = Math.round(performance.now() - startTime);
  recordLatency(provider.name, latencyMs);

  // Success: build a NEW Response dropping all upstream headers
  if (upstreamRes.ok) {
    const responseText = await upstreamRes.text();
    return new Response(responseText, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Provider": provider.name,
        "X-Gateway-Latency-Ms": latencyMs.toString(),
      },
    });
  }

  // Upstream Error Normalization
  const upstreamStatus = upstreamRes.status;
  const errorType =
    upstreamStatus === 429 ? "rate_limit_exceeded" : "upstream_error";

  // Log only provider name, status, and error type
  console.error(
    `Upstream provider error: provider=${provider.name}, status=${upstreamStatus}, error_type=${errorType}`
  );

  c.header("X-Gateway-Provider", provider.name);
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

  // Other 4xx
  return openAiError(
    c,
    502,
    "Upstream provider rejected the request.",
    "api_error",
    "bad_gateway"
  );
});

export { v1Routes };
