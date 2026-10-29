import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key_hash: text("key_hash").notNull().unique(),
  key_prefix: text("key_prefix").notNull(),
  rpm_limit: integer("rpm_limit").notNull().default(60),
  daily_token_quota: integer("daily_token_quota").notNull().default(100000),
  created_at: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revoked_at: integer("revoked_at", { mode: "timestamp" }),
});

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    api_key_id: text("api_key_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: integer("status").notNull(),
    latency_ms: integer("latency_ms").notNull(),
    prompt_tokens: integer("prompt_tokens").notNull(),
    completion_tokens: integer("completion_tokens").notNull(),
    usage_estimated: integer("usage_estimated", { mode: "boolean" })
      .notNull()
      .default(false),
    cache_hit: integer("cache_hit", { mode: "boolean" }).notNull().default(false),
    error_type: text("error_type"),
    created_at: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("idx_request_logs_created_at").on(table.created_at),
    index("idx_request_logs_api_key_id_created_at").on(table.api_key_id, table.created_at),
  ]
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
