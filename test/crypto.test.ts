import { describe, it, expect } from "vitest";
import { generateApiKey, sha256Hex, timingSafeEqual } from "../src/lib/crypto";

describe("crypto utilities", () => {
  describe("sha256Hex", () => {
    it("returns correct SHA-256 for known test vectors", async () => {
      // SHA-256 of empty string
      const emptyHash = await sha256Hex("");
      expect(emptyHash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );

      // SHA-256 of "hello world"
      const helloHash = await sha256Hex("hello world");
      expect(helloHash).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
      );
    });

    it("produces deterministic output", async () => {
      const hash1 = await sha256Hex("gateway-secret");
      const hash2 = await sha256Hex("gateway-secret");
      expect(hash1).toBe(hash2);
    });
  });

  describe("generateApiKey", () => {
    it("generates a key starting with gw_ and 64 hex characters (67 total)", () => {
      const { key, prefix } = generateApiKey();
      expect(key.startsWith("gw_")).toBe(true);
      expect(key.length).toBe(67);
      // "gw_" followed by 64 hex chars
      expect(/^gw_[0-9a-f]{64}$/.test(key)).toBe(true);
      expect(prefix).toBe(key.slice(0, 8));
      expect(prefix.length).toBe(8);
    });

    it("generates unique keys across multiple invocations", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.key).not.toBe(key2.key);
      expect(key1.prefix).not.toBe(key2.prefix);
    });
  });

  describe("timingSafeEqual", () => {
    it("returns true for identical strings", async () => {
      expect(await timingSafeEqual("secret-token-123", "secret-token-123")).toBe(true);
      expect(await timingSafeEqual("", "")).toBe(true);
    });

    it("returns false for different strings of same length", async () => {
      expect(await timingSafeEqual("token-a", "token-b")).toBe(false);
    });

    it("returns false for strings of different lengths", async () => {
      expect(await timingSafeEqual("short", "longer-string")).toBe(false);
      expect(await timingSafeEqual("token", "")).toBe(false);
      expect(await timingSafeEqual("", "token")).toBe(false);
    });
  });
});
