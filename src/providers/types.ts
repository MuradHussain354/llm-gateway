import type { Bindings } from "../types/env";
import type { ProviderName } from "../config/models";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface Provider {
  name: ProviderName;
  model: string;
  isConfigured(env: Bindings): boolean;
  chat(req: ChatCompletionRequest, env: Bindings, signal: AbortSignal): Promise<Response>;
}
