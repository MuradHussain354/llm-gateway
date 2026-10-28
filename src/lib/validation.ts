import { z } from "zod";
import { gatewayConfig, type ModelAlias } from "../config/models";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"] as const, {
    message: "role must be one of: 'system', 'user', 'assistant'",
  }),
  content: z
    .string({ message: "content must be a string" })
    .max(20000, { message: "Message content exceeds 20000 characters limit" }),
});

export const chatCompletionSchema = z.object({
  model: z.string().optional().default("default"),
  messages: z
    .array(chatMessageSchema, { message: "messages must be an array" })
    .min(1, { message: "messages must contain at least 1 message" })
    .max(50, { message: "messages must not exceed 50 messages" }),
  max_tokens: z
    .number({ message: "max_tokens must be an integer" })
    .int({ message: "max_tokens must be an integer" })
    .min(1, { message: "max_tokens must be at least 1" })
    .max(
      gatewayConfig.limits.MAX_TOKENS_CAP,
      { message: `max_tokens cannot exceed ${gatewayConfig.limits.MAX_TOKENS_CAP}` }
    )
    .optional(),
  temperature: z
    .number({ message: "temperature must be a number" })
    .min(0, { message: "temperature must be between 0 and 2" })
    .max(2, { message: "temperature must be between 0 and 2" })
    .optional(),
  stream: z.boolean({ message: "stream must be a boolean" }).optional(),
});

export type ValidatedChatRequest = z.infer<typeof chatCompletionSchema>;

export interface ValidationResult {
  success: boolean;
  data?: ValidatedChatRequest;
  error?: {
    status: 400 | 413;
    message: string;
    type: string;
    code: string;
  };
}

export function validateChatCompletionRequest(
  contentLengthHeader: string | null | undefined,
  rawBody: unknown
): ValidationResult {
  // 1. Content-Length header check
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (
      !isNaN(contentLength) &&
      contentLength > gatewayConfig.limits.MAX_CONTENT_LENGTH_BYTES
    ) {
      return {
        success: false,
        error: {
          status: 413,
          message: `Request entity too large. Maximum allowed Content-Length is ${gatewayConfig.limits.MAX_CONTENT_LENGTH_BYTES} bytes.`,
          type: "invalid_request_error",
          code: "request_too_large",
        },
      };
    }
  }

  // 2. Validate object structure with Zod
  const parsed = chatCompletionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      success: false,
      error: {
        status: 400,
        message: firstIssue.message,
        type: "invalid_request_error",
        code: "invalid_param",
      },
    };
  }

  const data = parsed.data;

  // 3. Reject streaming
  if (data.stream === true) {
    return {
      success: false,
      error: {
        status: 400,
        message: "streaming is not supported yet",
        type: "invalid_request_error",
        code: "stream_not_supported",
      },
    };
  }

  // 4. Combined message content length check
  const totalContentChars = data.messages.reduce(
    (acc, m) => acc + m.content.length,
    0
  );
  if (totalContentChars > gatewayConfig.limits.MAX_COMBINED_CONTENT_CHARS) {
    return {
      success: false,
      error: {
        status: 400,
        message: `Combined message content length of ${totalContentChars} characters exceeds the ${gatewayConfig.limits.MAX_COMBINED_CONTENT_CHARS} characters limit.`,
        type: "invalid_request_error",
        code: "content_length_exceeded",
      },
    };
  }

  // 5. Model alias validation
  const validAliases = Object.keys(gatewayConfig.aliases) as ModelAlias[];
  if (!validAliases.includes(data.model as ModelAlias)) {
    const aliasesList = validAliases.map((a) => `"${a}"`).join(", ");
    return {
      success: false,
      error: {
        status: 400,
        message: `Unknown model '${data.model}'. Valid aliases: ${aliasesList}.`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    };
  }

  return {
    success: true,
    data,
  };
}
