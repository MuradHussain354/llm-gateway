import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { v1Routes } from "../src/routes/v1";
import { sha256Hex } from "../src/lib/crypto";
import * as dbClient from "../src/db/client";
import type { AppEnv } from "../src/types/env";
import type { ApiKey } from "../src/db/schema";

describe("V1 User Routes (/v1/me)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const app = new Hono<AppEnv>();
    app.use("/v1/*", authMiddleware);
    app.route("/v1", v1Routes);

    const res = await app.request("/v1/me", {}, { DB: {} as D1Database });
    expect(res.status).toBe(401);
    const data = (await res.json()) as any;
    expect(data.error.code).toBe("invalid_api_key");
  });

  it("returns name and key_prefix when authenticated with valid key", async () => {
    const rawKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const keyHash = await sha256Hex(rawKey);

    const validKey: ApiKey = {
      id: "key-v1-test",
      name: "Test Client App",
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

    const app = new Hono<AppEnv>();
    app.use("/v1/*", authMiddleware);
    app.route("/v1", v1Routes);

    const res = await app.request(
      "/v1/me",
      {
        headers: { Authorization: `Bearer ${rawKey}` },
      },
      { DB: {} as D1Database }
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data).toEqual({
      name: "Test Client App",
      key_prefix: "gw_01234",
    });
  });
});
