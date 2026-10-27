import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { adminMiddleware } from "../src/middleware/admin";
import { authMiddleware } from "../src/middleware/auth";
import { sha256Hex } from "../src/lib/crypto";
import * as dbClient from "../src/db/client";
import type { AppEnv } from "../src/types/env";
import type { ApiKey } from "../src/db/schema";

describe("Middleware", () => {
  describe("adminMiddleware", () => {
    it("fails closed with 401 when ADMIN_TOKEN is unset", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Bearer some-token" },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: undefined,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("ADMIN_TOKEN is not configured");
      expect(data.error.type).toBe("invalid_request_error");
    });

    it("fails closed with 401 when ADMIN_TOKEN is empty string", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Bearer some-token" },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "   ",
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("ADMIN_TOKEN is not configured");
    });

    it("returns 401 when Authorization header is missing", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {}, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "valid-admin-secret",
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("Missing or malformed Authorization header");
    });

    it("returns 401 when Authorization header is malformed (not Bearer)", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Basic valid-admin-secret" },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "valid-admin-secret",
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("Missing or malformed Authorization header");
    });

    it("returns 401 when Bearer token is empty", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Bearer " },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "valid-admin-secret",
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("Missing admin token");
    });

    it("returns 401 when token is incorrect", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Bearer wrong-token" },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "valid-admin-secret",
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("Invalid admin token");
    });

    it("passes through to handler when token matches ADMIN_TOKEN", async () => {
      const app = new Hono<AppEnv>();
      app.use("/admin/*", adminMiddleware);
      app.get("/admin/test", (c) => c.json({ ok: true }));

      const res = await app.request("/admin/test", {
        headers: { Authorization: "Bearer valid-admin-secret" },
      }, {
        DB: {} as D1Database,
        ADMIN_TOKEN: "valid-admin-secret",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({ ok: true });
    });
  });

  describe("authMiddleware", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log");
      errorSpy = vi.spyOn(console, "error");
      warnSpy = vi.spyOn(console, "warn");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns 401 when Authorization header is missing", async () => {
      const app = new Hono<AppEnv>();
      app.use("/v1/*", authMiddleware);
      app.get("/v1/me", (c) => c.json({ ok: true }));

      const res = await app.request("/v1/me", {}, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.code).toBe("invalid_api_key");
    });

    it("returns 401 when Authorization header does not use Bearer auth", async () => {
      const app = new Hono<AppEnv>();
      app.use("/v1/*", authMiddleware);
      app.get("/v1/me", (c) => c.json({ ok: true }));

      const res = await app.request("/v1/me", {
        headers: { Authorization: "Token my-secret-key" },
      }, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.code).toBe("invalid_api_key");
    });

    it("returns 401 when Authorization header is empty Bearer", async () => {
      const app = new Hono<AppEnv>();
      app.use("/v1/*", authMiddleware);
      app.get("/v1/me", (c) => c.json({ ok: true }));

      const res = await app.request("/v1/me", {
        headers: { Authorization: "Bearer   " },
      }, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.code).toBe("invalid_api_key");
    });

    it("returns 401 when key is unknown (not found in DB)", async () => {
      const rawKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const mockDb = {
        query: {
          apiKeys: {
            findFirst: vi.fn().mockResolvedValue(undefined),
          },
        },
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const app = new Hono<AppEnv>();
      app.use("/v1/*", authMiddleware);
      app.get("/v1/me", (c) => c.json({ ok: true }));

      const res = await app.request("/v1/me", {
        headers: { Authorization: `Bearer ${rawKey}` },
      }, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("Incorrect API key");
      expect(data.error.code).toBe("invalid_api_key");

      // Verify rawKey is NEVER logged
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
    });

    it("returns 401 when key is revoked", async () => {
      const rawKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const keyHash = await sha256Hex(rawKey);

      const revokedKey: ApiKey = {
        id: "key-123",
        name: "Test Key",
        key_hash: keyHash,
        key_prefix: "gw_01234",
        rpm_limit: 60,
        daily_token_quota: 100000,
        created_at: new Date(),
        revoked_at: new Date(),
      };

      const mockDb = {
        query: {
          apiKeys: {
            findFirst: vi.fn().mockResolvedValue(revokedKey),
          },
        },
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const app = new Hono<AppEnv>();
      app.use("/v1/*", authMiddleware);
      app.get("/v1/me", (c) => c.json({ ok: true }));

      const res = await app.request("/v1/me", {
        headers: { Authorization: `Bearer ${rawKey}` },
      }, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("revoked");
      expect(data.error.code).toBe("api_key_revoked");
    });

    it("authenticates valid key and stores key record in context", async () => {
      const rawKey = "gw_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const keyHash = await sha256Hex(rawKey);

      const validKey: ApiKey = {
        id: "key-valid-123",
        name: "Production Service",
        key_hash: keyHash,
        key_prefix: "gw_01234",
        rpm_limit: 120,
        daily_token_quota: 500000,
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
      app.get("/v1/me", (c) => {
        const key = c.get("apiKey");
        return c.json({ id: key.id, name: key.name });
      });

      const res = await app.request("/v1/me", {
        headers: { Authorization: `Bearer ${rawKey}` },
      }, {
        DB: {} as D1Database,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({ id: "key-valid-123", name: "Production Service" });

      // Verify rawKey is NEVER logged
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(rawKey));
    });
  });
});
