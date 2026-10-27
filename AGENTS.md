# LLM Gateway: agent rules

Project: LLM Gateway, an OpenAI-compatible proxy over multiple LLM providers.
Stack: TypeScript (strict), Hono, Cloudflare Workers, D1 with Drizzle, KV, Durable Objects.

Rules:
- Never hardcode secrets. Read them from env bindings only.
- Never read, print, edit or commit .dev.vars or any .env file.
- Never log prompt or response content by default.
- API keys are stored only as SHA-256 hashes.
- Do not run destructive commands (rm -rf, deleting files outside src, dropping databases).
- Do not deploy and do not run wrangler secret commands. Tell me the command and I will run it.
- Write small, typed modules with unit tests (Vitest).
- After each task, summarize what changed and how to verify it.