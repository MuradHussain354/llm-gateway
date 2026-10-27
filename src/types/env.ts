import type { ApiKey } from "../db/schema";

export type Bindings = {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
};

export type Variables = {
  apiKey: ApiKey;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
