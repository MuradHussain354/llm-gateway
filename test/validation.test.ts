import { describe, it, expect } from "vitest";
import { validateChatCompletionRequest } from "../src/lib/validation";

describe("Validation module (src/lib/validation.ts)", () => {
  it("passes for valid default chat completion payload", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "user", content: "Hello world" }],
    });

    expect(result.success).toBe(true);
    expect(result.data?.model).toBe("default");
    expect(result.data?.messages).toHaveLength(1);
  });

  it("rejects invalid role (e.g. 'tool')", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "tool", content: "some output" }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("role");
  });

  it("rejects empty messages array", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("at least 1 message");
  });

  it("rejects message content exceeding 20000 characters", () => {
    const longContent = "a".repeat(20001);
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "user", content: longContent }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("20000 characters");
  });

  it("rejects max_tokens exceeding MAX_TOKENS_CAP (1024)", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("cannot exceed 1024");
  });

  it("rejects non-integer max_tokens", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 50.5,
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("integer");
  });

  it("rejects stream: true with 'streaming is not supported yet'", () => {
    const result = validateChatCompletionRequest(null, {
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toBe("streaming is not supported yet");
  });

  it("rejects when Content-Length header exceeds 100000 bytes with 413", () => {
    const result = validateChatCompletionRequest("100001", {
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(413);
    expect(result.error?.code).toBe("request_too_large");
  });

  it("rejects when combined message content length exceeds 50000 characters with 400", () => {
    const message1 = "a".repeat(18000);
    const message2 = "b".repeat(18000);
    const message3 = "c".repeat(15000); // 18000 + 18000 + 15000 = 51000

    const result = validateChatCompletionRequest(null, {
      messages: [
        { role: "user", content: message1 },
        { role: "assistant", content: message2 },
        { role: "user", content: message3 },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe("content_length_exceeded");
    expect(result.error?.message).toContain("50000 characters limit");
  });

  it("rejects unknown model alias and lists valid aliases in message", () => {
    const result = validateChatCompletionRequest(null, {
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
    expect(result.error?.code).toBe("model_not_found");
    expect(result.error?.message).toContain("Unknown model 'gpt-4-turbo'");
    expect(result.error?.message).toContain('"default"');
    expect(result.error?.message).toContain('"fast"');
    expect(result.error?.message).toContain('"gemini"');
    expect(result.error?.message).toContain('"groq"');
    expect(result.error?.message).toContain('"openrouter"');
  });
});
