CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`rpm_limit` integer DEFAULT 60 NOT NULL,
	`daily_token_quota` integer DEFAULT 100000 NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cache_hit` integer DEFAULT false NOT NULL,
	`error_type` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_request_logs_created_at` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_api_key_id_created_at` ON `request_logs` (`api_key_id`,`created_at`);