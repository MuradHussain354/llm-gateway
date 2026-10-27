import { describe, it, expect } from "vitest";
import app from "../src/index";

describe("Health Check Endpoint", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
