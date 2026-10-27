import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { sha256Hex } from "../lib/crypto";
import { openAiError } from "../lib/errors";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import type { AppEnv } from "../types/env";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || (!authHeader.startsWith("Bearer ") && authHeader !== "Bearer")) {
    return openAiError(
      c,
      401,
      "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).",
      "invalid_request_error",
      "invalid_api_key"
    );
  }

  const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!rawKey) {
    return openAiError(
      c,
      401,
      "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).",
      "invalid_request_error",
      "invalid_api_key"
    );
  }

  const keyHash = await sha256Hex(rawKey);
  const db = getDb(c.env.DB);

  const keyRecord = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.key_hash, keyHash),
  });

  if (!keyRecord) {
    return openAiError(
      c,
      401,
      "Incorrect API key provided.",
      "invalid_request_error",
      "invalid_api_key"
    );
  }

  if (keyRecord.revoked_at !== null) {
    return openAiError(
      c,
      401,
      "API key has been revoked.",
      "invalid_request_error",
      "api_key_revoked"
    );
  }

  c.set("apiKey", keyRecord);
  await next();
});
