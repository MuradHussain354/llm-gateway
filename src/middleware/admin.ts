import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "../lib/crypto";
import { openAiError } from "../lib/errors";
import type { AppEnv } from "../types/env";

export const adminMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const adminToken = c.env.ADMIN_TOKEN;

  if (!adminToken || adminToken.trim() === "") {
    return openAiError(
      c,
      401,
      "Admin access is disabled. ADMIN_TOKEN is not configured.",
      "invalid_request_error",
      "unauthorized"
    );
  }

  const authHeader = c.req.header("Authorization");

  if (!authHeader || (!authHeader.startsWith("Bearer ") && authHeader !== "Bearer")) {
    return openAiError(
      c,
      401,
      "Missing or malformed Authorization header.",
      "invalid_request_error",
      "unauthorized"
    );
  }

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return openAiError(
      c,
      401,
      "Missing admin token.",
      "invalid_request_error",
      "unauthorized"
    );
  }

  const isMatch = await timingSafeEqual(token, adminToken);
  if (!isMatch) {
    return openAiError(
      c,
      401,
      "Invalid admin token.",
      "invalid_request_error",
      "unauthorized"
    );
  }

  await next();
});
