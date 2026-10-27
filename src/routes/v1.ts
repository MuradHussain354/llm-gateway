import { Hono } from "hono";
import type { AppEnv } from "../types/env";

const v1Routes = new Hono<AppEnv>();

v1Routes.get("/me", (c) => {
  const apiKey = c.get("apiKey");
  return c.json({
    name: apiKey.name,
    key_prefix: apiKey.key_prefix,
  });
});

export { v1Routes };
