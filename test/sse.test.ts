import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSseTransform, type SseStreamResult } from "../src/lib/sse";

describe("SSE Transformer (src/lib/sse.ts)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    return result;
  }

  it("passes SSE bytes through in order and unchanged", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
    });

    const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const chunk2 = 'data: {"choices":[{"delta":{"content":" world"}}]}\n\n';
    const chunk3 = 'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n';
    const chunk4 = "data: [DONE]\n\n";

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1));
        controller.enqueue(encoder.encode(chunk2));
        controller.enqueue(encoder.encode(chunk3));
        controller.enqueue(encoder.encode(chunk4));
        controller.close();
      },
    });

    const output = await readStream(readable.pipeThrough(transform));

    expect(output).toBe(chunk1 + chunk2 + chunk3 + chunk4);
    expect(finalResult).not.toBeNull();
    expect(finalResult?.prompt_tokens).toBe(5);
    expect(finalResult?.completion_tokens).toBe(2);
    expect(finalResult?.usage_estimated).toBe(false);
    expect(finalResult?.error_type).toBeNull();
  });

  it("parses lines split across chunks correctly", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
    });

    // Line split across chunks:
    // Chunk A: 'data: {"usage":{"prompt_tokens":12,'
    // Chunk B: '"completion_tokens":8}}\n\n'
    const chunkA = 'data: {"usage":{"prompt_tokens":12,';
    const chunkB = '"completion_tokens":8}}\n\n';

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunkA));
        controller.enqueue(encoder.encode(chunkB));
        controller.close();
      },
    });

    await readStream(readable.pipeThrough(transform));

    expect(finalResult?.prompt_tokens).toBe(12);
    expect(finalResult?.completion_tokens).toBe(8);
    expect(finalResult?.usage_estimated).toBe(false);
  });

  it("uses character estimate when no usage chunk arrives and sets usage_estimated = true", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 40, // 40 chars -> ceil(40/4) = 10 prompt tokens
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
    });

    // Content: "Hello world!" (12 chars) -> ceil(12/4) = 3 completion tokens
    const chunk = 'data: {"choices":[{"delta":{"content":"Hello world!"}}]}\n\ndata: [DONE]\n\n';

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    await readStream(readable.pipeThrough(transform));

    expect(finalResult?.prompt_tokens).toBe(10);
    expect(finalResult?.completion_tokens).toBe(3);
    expect(finalResult?.usage_estimated).toBe(true);
    expect(finalResult?.error_type).toBeNull();
  });

  it("aborts upstream, ends stream, and logs upstream_stream_error if line buffer exceeds 1 MB", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
    });

    // A single line without newline exceeding 1 MB
    const hugeLine = "data: " + "a".repeat(1024 * 1024 + 10);
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(hugeLine));
      },
    });

    await expect(readStream(readable.pipeThrough(transform))).rejects.toThrow();
    expect(abortController.signal.aborted).toBe(true);
    expect(finalResult?.error_type).toBe("upstream_stream_error");
  });

  it("aborts upstream and logs upstream_idle_timeout when chunk interval exceeds 30 seconds", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
      idleTimeoutMs: 30000,
    });

    const encoder = new TextEncoder();
    let pushChunk!: (data: string) => void;

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        pushChunk = (data) => controller.enqueue(encoder.encode(data));
      },
    });

    const outputPromise = readStream(readable.pipeThrough(transform));
    const assertionPromise = expect(outputPromise).rejects.toThrow();

    // Send first chunk
    pushChunk('data: {"choices":[{"delta":{"content":"First"}}]}\n\n');

    // Advance 31 seconds without any new chunk
    await vi.advanceTimersByTimeAsync(31000);

    await assertionPromise;
    expect(abortController.signal.aborted).toBe(true);
    expect(finalResult?.error_type).toBe("upstream_idle_timeout");
  });

  it("allows stream to last longer than 30 seconds in total if chunks arrive regularly", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
      idleTimeoutMs: 30000,
    });

    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;

    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });

    const outputPromise = readStream(readable.pipeThrough(transform));

    // Emit 5 chunks spaced 10 seconds apart (total duration: 50 seconds > 30s)
    for (let i = 0; i < 5; i++) {
      streamController.enqueue(
        encoder.encode(`data: {"choices":[{"delta":{"content":"Chunk ${i} "}}]}\n\n`)
      );
      await vi.advanceTimersByTimeAsync(10000);
    }

    streamController.enqueue(
      encoder.encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":25}}\n\ndata: [DONE]\n\n')
    );
    streamController.close();

    const output = await outputPromise;
    expect(output).toContain("Chunk 4");
    expect(abortController.signal.aborted).toBe(false);
    expect(finalResult?.prompt_tokens).toBe(10);
    expect(finalResult?.completion_tokens).toBe(25);
    expect(finalResult?.error_type).toBeNull();
  });

  it("aborts upstream and logs client_disconnect when reader cancels stream", async () => {
    const abortController = new AbortController();
    let finalResult: any = null;

    const transform = createSseTransform({
      totalPromptChars: 20,
      upstreamAbortController: abortController,
      onDone: (res) => {
        finalResult = res;
      },
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Part"}}]}\n\n'));
      },
    });

    const piped = readable.pipeThrough(transform);
    const reader = piped.getReader();

    // Read first chunk
    await reader.read();

    // Client disconnects
    await reader.cancel("Client closed connection");

    expect(abortController.signal.aborted).toBe(true);
    expect(finalResult?.error_type).toBe("client_disconnect");
  });
});
