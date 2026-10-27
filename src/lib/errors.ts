import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function openAiError(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  type: string = "invalid_request_error",
  code: string | null = null
) {
  return c.json(
    {
      error: {
        message,
        type,
        code,
      },
    },
    status
  );
}
