import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { sha256Hex } from "../src/lib/crypto";
import * as dbClient from "../src/db/client";
import type { AppEnv } from "../src/types/env";

describe("Admin Routes (/admin/keys)", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = new Hono<AppEnv>();
    app.route("/admin", adminRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /admin/keys", () => {
    it("returns 400 in OpenAI error format when request body is not valid JSON", async () => {
      const res = await app.request(
        "/admin/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ invalid json ...",
        },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { message: string; type: string; code: string } };
      expect(data.error.message).toContain("Invalid JSON");
      expect(data.error.type).toBe("invalid_request_error");
      expect(data.error.code).toBe("invalid_payload");
    });

    it("returns 400 when body is not a JSON object", async () => {
      const res = await app.request(
        "/admin/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(["an", "array"]),
        },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { message: string } };
      expect(data.error.message).toContain("JSON object");
    });

    describe("name validation", () => {
      it("rejects missing name", async () => {
        const res = await app.request(
          "/admin/keys",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
          { DB: {} as D1Database }
        );

        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { message: string } };
        expect(data.error.message).toContain("'name' must be a string");
      });

      it("rejects empty name", async () => {
        const res = await app.request(
          "/admin/keys",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "" }),
          },
          { DB: {} as D1Database }
        );

        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { message: string } };
        expect(data.error.message).toContain("'name' must be a string between 1 and 64 characters");
      });

      it("rejects name longer than 64 characters", async () => {
        const res = await app.request(
          "/admin/keys",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "a".repeat(65) }),
          },
          { DB: {} as D1Database }
        );

        expect(res.status).toBe(400);
        const data = (await res.json()) as { error: { message: string } };
        expect(data.error.message).toContain("'name' must be a string between 1 and 64 characters");
      });
    });

    describe("rpm_limit validation", () => {
      const testCases = [
        { desc: "rejects float", val: 60.5 },
        { desc: "rejects string", val: "60" },
        { desc: "rejects negative", val: -5 },
        { desc: "rejects zero", val: 0 },
        { desc: "rejects value > 10000", val: 10001 },
      ];

      for (const tc of testCases) {
        it(tc.desc, async () => {
          const res = await app.request(
            "/admin/keys",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "test-key", rpm_limit: tc.val }),
            },
            { DB: {} as D1Database }
          );

          expect(res.status).toBe(400);
          const data = (await res.json()) as { error: { message: string } };
          expect(data.error.message).toContain("'rpm_limit' must be an integer between 1 and 10000");
        });
      }
    });

    describe("daily_token_quota validation", () => {
      const testCases = [
        { desc: "rejects float", val: 100.5 },
        { desc: "rejects string", val: "100000" },
        { desc: "rejects negative", val: -1 },
        { desc: "rejects zero", val: 0 },
        { desc: "rejects value > 10000000", val: 10000001 },
      ];

      for (const tc of testCases) {
        it(tc.desc, async () => {
          const res = await app.request(
            "/admin/keys",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "test-key", daily_token_quota: tc.val }),
            },
            { DB: {} as D1Database }
          );

          expect(res.status).toBe(400);
          const data = (await res.json()) as { error: { message: string } };
          expect(data.error.message).toContain("'daily_token_quota' must be an integer between 1 and 10000000");
        });
      }
    });

    it("proves plaintext key is returned in response but NEVER passed to DB insert", async () => {
      let capturedInsertPayload: any = null;

      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val) => {
            capturedInsertPayload = val;
            return Promise.resolve();
          }),
        }),
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const res = await app.request(
        "/admin/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Production Gateway Key",
            rpm_limit: 120,
            daily_token_quota: 250000,
          }),
        },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;

      // Plaintext key returned once in response
      expect(body.key).toBeDefined();
      expect(typeof body.key).toBe("string");
      expect(body.key.startsWith("gw_")).toBe(true);
      expect(body.name).toBe("Production Gateway Key");
      expect(body.rpm_limit).toBe(120);
      expect(body.daily_token_quota).toBe(250000);
      expect(body.key_prefix).toBe(body.key.slice(0, 8));

      // CRITICAL ASSERTION: The plaintext key is NOT present anywhere in what was passed to DB insert
      expect(capturedInsertPayload).not.toBeNull();
      const insertJson = JSON.stringify(capturedInsertPayload);
      expect(insertJson).not.toContain(body.key);
      expect(capturedInsertPayload.key).toBeUndefined();

      // Verify DB received the hash and prefix instead
      const expectedHash = await sha256Hex(body.key);
      expect(capturedInsertPayload.key_hash).toBe(expectedHash);
      expect(capturedInsertPayload.key_prefix).toBe(body.key.slice(0, 8));
      expect(capturedInsertPayload.name).toBe("Production Gateway Key");
    });

    it("applies default limits when optional fields are omitted", async () => {
      let capturedInsertPayload: any = null;

      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val) => {
            capturedInsertPayload = val;
            return Promise.resolve();
          }),
        }),
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const res = await app.request(
        "/admin/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Default Limits Key" }),
        },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.rpm_limit).toBe(60);
      expect(body.daily_token_quota).toBe(100000);
      expect(capturedInsertPayload.rpm_limit).toBe(60);
      expect(capturedInsertPayload.daily_token_quota).toBe(100000);
    });
  });

  describe("GET /admin/keys", () => {
    it("proves the response of GET /admin/keys NEVER contains key_hash or any full key", async () => {
      const mockKeys = [
        {
          id: "key-1",
          name: "Test 1",
          key_prefix: "gw_11111",
          rpm_limit: 60,
          daily_token_quota: 100000,
          created_at: new Date("2025-01-01"),
          revoked_at: null,
        },
        {
          id: "key-2",
          name: "Test 2",
          key_prefix: "gw_22222",
          rpm_limit: 120,
          daily_token_quota: 200000,
          created_at: new Date("2025-01-02"),
          revoked_at: new Date("2025-01-03"),
        },
      ];

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue(mockKeys),
        }),
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const res = await app.request("/admin/keys", {}, { DB: {} as D1Database });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;

      expect(json.data).toHaveLength(2);

      // Stringified response must not contain key_hash
      const rawString = JSON.stringify(json);
      expect(rawString).not.toContain("key_hash");

      // Verify each object does not have key_hash or full key
      for (const item of json.data) {
        expect(item.key_hash).toBeUndefined();
        expect(item.key).toBeUndefined();
        expect(item.key_prefix).toBeDefined();
        expect(item.key_prefix.length).toBe(8);
      }
    });
  });

  describe("DELETE /admin/keys/:id", () => {
    it("returns 404 when key does not exist", async () => {
      const mockDb = {
        query: {
          apiKeys: {
            findFirst: vi.fn().mockResolvedValue(undefined),
          },
        },
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const res = await app.request(
        "/admin/keys/non-existent-id",
        { method: "DELETE" },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error.message).toContain("API key not found");
      expect(data.error.code).toBe("not_found");
    });

    it("revokes key and returns success", async () => {
      const existingKey = {
        id: "key-to-revoke",
        name: "Old Key",
        key_hash: "hash",
        key_prefix: "gw_12345",
        rpm_limit: 60,
        daily_token_quota: 100000,
        created_at: new Date(),
        revoked_at: null,
      };

      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      const mockDb = {
        query: {
          apiKeys: {
            findFirst: vi.fn().mockResolvedValue(existingKey),
          },
        },
        update: vi.fn().mockReturnValue({ set: updateSet }),
      };
      vi.spyOn(dbClient, "getDb").mockReturnValue(mockDb as unknown as dbClient.DbClient);

      const res = await app.request(
        "/admin/keys/key-to-revoke",
        { method: "DELETE" },
        { DB: {} as D1Database }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.id).toBe("key-to-revoke");
      expect(data.revoked_at).toBeDefined();
      expect(updateSet).toHaveBeenCalled();
    });
  });
});
