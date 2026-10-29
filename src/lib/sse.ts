export interface SseStreamResult {
  prompt_tokens: number;
  completion_tokens: number;
  usage_estimated: boolean;
  error_type: string | null;
}

export interface SseTransformOptions {
  totalPromptChars: number;
  upstreamAbortController: AbortController;
  onDone: (result: SseStreamResult) => void;
  idleTimeoutMs?: number; // defaults to 30000ms
}

export function createSseTransform(options: SseTransformOptions): TransformStream<Uint8Array, Uint8Array> {
  const {
    totalPromptChars,
    upstreamAbortController,
    onDone,
    idleTimeoutMs = 30000,
  } = options;

  const decoder = new TextDecoder();
  let lineBuffer = "";
  const MAX_LINE_BUFFER_BYTES = 1024 * 1024; // 1 MB

  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let streamedContentChars = 0;
  let hasFinished = false;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function finalize(errorType: string | null) {
    if (hasFinished) return;
    hasFinished = true;
    clearIdleTimer();

    let finalPromptTokens = promptTokens;
    let finalCompletionTokens = completionTokens;
    let usageEstimated = false;

    if (finalPromptTokens === null || finalCompletionTokens === null) {
      finalPromptTokens = Math.ceil(totalPromptChars / 4);
      finalCompletionTokens = Math.ceil(streamedContentChars / 4);
      usageEstimated = true;
    }

    onDone({
      prompt_tokens: finalPromptTokens,
      completion_tokens: finalCompletionTokens,
      usage_estimated: usageEstimated,
      error_type: errorType,
    });
  }

  function resetIdleTimer(controller: TransformStreamDefaultController<Uint8Array>) {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (hasFinished) return;
      upstreamAbortController.abort();
      finalize("upstream_idle_timeout");
      try {
        controller.error(new Error("Upstream idle timeout"));
      } catch {
        // controller might already be closed
      }
    }, idleTimeoutMs);
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // Start initial idle timer waiting for the first chunk
      resetIdleTimer(controller);
    },

    transform(chunk, controller) {
      // 1. Immediately forward raw bytes untouched
      controller.enqueue(chunk);

      // 2. Reset idle timer on every chunk
      resetIdleTimer(controller);

      // 3. Decode text incrementally
      const text = decoder.decode(chunk, { stream: true });
      lineBuffer += text;

      // 4. Enforce 1 MB buffer limit
      if (lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
        upstreamAbortController.abort();
        finalize("upstream_stream_error");
        controller.error(new Error("SSE line buffer exceeded 1 MB limit"));
        return;
      }

      // 5. Parse complete lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;

        const dataContent = line.slice(5).trim();
        if (!dataContent || dataContent === "[DONE]") continue;

        try {
          const parsed = JSON.parse(dataContent);

          if (parsed.usage && typeof parsed.usage.prompt_tokens === "number") {
            promptTokens = parsed.usage.prompt_tokens;
            completionTokens = parsed.usage.completion_tokens ?? 0;
          }

          const deltaContent = parsed.choices?.[0]?.delta?.content;
          if (typeof deltaContent === "string") {
            streamedContentChars += deltaContent.length;
          }
        } catch {
          // Incomplete or non-JSON data is ignored
        }
      }
    },

    flush() {
      // Parse any remaining lineBuffer
      if (lineBuffer.trim().startsWith("data:")) {
        const dataContent = lineBuffer.trim().slice(5).trim();
        if (dataContent && dataContent !== "[DONE]") {
          try {
            const parsed = JSON.parse(dataContent);
            if (parsed.usage && typeof parsed.usage.prompt_tokens === "number") {
              promptTokens = parsed.usage.prompt_tokens;
              completionTokens = parsed.usage.completion_tokens ?? 0;
            }
          } catch {
            // Ignore
          }
        }
      }

      finalize(null);
    },

    cancel() {
      // Client disconnects
      upstreamAbortController.abort();
      finalize("client_disconnect");
    },
  });
}
