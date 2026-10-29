import type { Context } from "hono";
import { getDb } from "../db/client";
import { requestLogs, type NewRequestLog } from "../db/schema";
import type { AppEnv } from "../types/env";

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function getSafeExecutionCtx(
  c: Context<AppEnv>
): WaitUntilContext | undefined {
  try {
    return c.executionCtx as unknown as WaitUntilContext;
  } catch {
    return undefined;
  }
}

export async function insertRequestLog(
  d1: D1Database,
  entry: NewRequestLog
): Promise<void> {
  try {
    const db = getDb(d1);
    await db.insert(requestLogs).values({
      id: entry.id,
      api_key_id: entry.api_key_id,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      latency_ms: entry.latency_ms,
      prompt_tokens: entry.prompt_tokens,
      completion_tokens: entry.completion_tokens,
      usage_estimated: entry.usage_estimated ?? false,
      cache_hit: entry.cache_hit ?? false,
      error_type: entry.error_type ?? null,
      created_at: entry.created_at ?? new Date(),
    });
  } catch (err: unknown) {
    // Logging failure must never break the client response
    console.error("Failed to write request log to D1:", err);
  }
}

export function queueRequestLog(
  c: Context<AppEnv>,
  entry: NewRequestLog
): Promise<void> {
  const promise = insertRequestLog(c.env.DB, entry);

  const ctx = getSafeExecutionCtx(c);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
  }

  return promise;
}
