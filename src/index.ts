import { Hono } from "hono";

export type Env = {
  Bindings: {
    DB: D1Database;
    ADMIN_TOKEN?: string;
    GEMINI_API_KEY?: string;
    GROQ_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
  };
};

const app = new Hono<Env>();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export default app;
