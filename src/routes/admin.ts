import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { generateApiKey, sha256Hex } from "../lib/crypto";
import { openAiError } from "../lib/errors";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import type { AppEnv } from "../types/env";

const adminRoutes = new Hono<AppEnv>();

adminRoutes.post("/keys", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return openAiError(
      c,
      400,
      "Invalid JSON in request body.",
      "invalid_request_error",
      "invalid_payload"
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return openAiError(
      c,
      400,
      "Request body must be a JSON object.",
      "invalid_request_error",
      "invalid_payload"
    );
  }

  const payload = body as Record<string, unknown>;

  if (
    typeof payload.name !== "string" ||
    payload.name.length < 1 ||
    payload.name.length > 64
  ) {
    return openAiError(
      c,
      400,
      "'name' must be a string between 1 and 64 characters.",
      "invalid_request_error",
      "invalid_param"
    );
  }

  let rpmLimit = 60;
  if (payload.rpm_limit !== undefined) {
    if (
      typeof payload.rpm_limit !== "number" ||
      !Number.isInteger(payload.rpm_limit) ||
      payload.rpm_limit < 1 ||
      payload.rpm_limit > 10000
    ) {
      return openAiError(
        c,
        400,
        "'rpm_limit' must be an integer between 1 and 10000.",
        "invalid_request_error",
        "invalid_param"
      );
    }
    rpmLimit = payload.rpm_limit;
  }

  let dailyTokenQuota = 100000;
  if (payload.daily_token_quota !== undefined) {
    if (
      typeof payload.daily_token_quota !== "number" ||
      !Number.isInteger(payload.daily_token_quota) ||
      payload.daily_token_quota < 1 ||
      payload.daily_token_quota > 10000000
    ) {
      return openAiError(
        c,
        400,
        "'daily_token_quota' must be an integer between 1 and 10000000.",
        "invalid_request_error",
        "invalid_param"
      );
    }
    dailyTokenQuota = payload.daily_token_quota;
  }

  const { key, prefix } = generateApiKey();
  const keyHash = await sha256Hex(key);
  const id = crypto.randomUUID();
  const createdAt = new Date();

  const insertData = {
    id,
    name: payload.name,
    key_hash: keyHash,
    key_prefix: prefix,
    rpm_limit: rpmLimit,
    daily_token_quota: dailyTokenQuota,
    created_at: createdAt,
    revoked_at: null,
  };

  const db = getDb(c.env.DB);
  await db.insert(apiKeys).values(insertData);

  return c.json(
    {
      id,
      name: payload.name,
      key,
      key_prefix: prefix,
      rpm_limit: rpmLimit,
      daily_token_quota: dailyTokenQuota,
      created_at: createdAt,
    },
    201
  );
});

adminRoutes.get("/keys", async (c) => {
  const db = getDb(c.env.DB);
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      key_prefix: apiKeys.key_prefix,
      rpm_limit: apiKeys.rpm_limit,
      daily_token_quota: apiKeys.daily_token_quota,
      created_at: apiKeys.created_at,
      revoked_at: apiKeys.revoked_at,
    })
    .from(apiKeys);

  return c.json({ data: keys });
});

adminRoutes.delete("/keys/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const existing = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.id, id),
  });

  if (!existing) {
    return openAiError(
      c,
      404,
      "API key not found.",
      "invalid_request_error",
      "not_found"
    );
  }

  const now = new Date();
  await db
    .update(apiKeys)
    .set({ revoked_at: now })
    .where(eq(apiKeys.id, id));

  return c.json({
    success: true,
    id,
    revoked_at: now,
  });
});

export { adminRoutes };
