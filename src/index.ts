import { Hono } from "hono";
import { openAiError } from "./lib/errors";
import { adminMiddleware } from "./middleware/admin";
import { authMiddleware } from "./middleware/auth";
import { adminRoutes } from "./routes/admin";
import { v1Routes } from "./routes/v1";
import type { AppEnv, Bindings, Variables } from "./types/env";

export type { Bindings, Variables, AppEnv };

const app = new Hono<AppEnv>();

// Health check endpoint (public)
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Admin endpoints protected by adminMiddleware
app.use("/admin/*", adminMiddleware);
app.route("/admin", adminRoutes);

// V1 API endpoints protected by authMiddleware
app.use("/v1/*", authMiddleware);
app.route("/v1", v1Routes);

// Fallbacks for not found and errors
app.notFound((c) => {
  return openAiError(c, 404, `Route ${c.req.method} ${c.req.path} not found.`, "invalid_request_error");
});

app.onError((err, c) => {
  return openAiError(c, 500, err.message || "Internal server error.", "api_error");
});

export default app;
