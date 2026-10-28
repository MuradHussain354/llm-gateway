import { gatewayConfig, type ProviderName } from "../config/models";
import type { Bindings } from "../types/env";
import type { ChatCompletionRequest, Provider } from "./types";

export class BaseProviderAdapter implements Provider {
  constructor(public readonly name: ProviderName) {}

  isConfigured(env: Bindings): boolean {
    const key = gatewayConfig.providers[this.name].getKey(env);
    return typeof key === "string" && key.trim().length > 0;
  }

  async chat(
    req: ChatCompletionRequest,
    env: Bindings,
    signal: AbortSignal
  ): Promise<Response> {
    const config = gatewayConfig.providers[this.name];
    const key = config.getKey(env);

    if (!key || key.trim().length === 0) {
      throw new Error(`Provider ${this.name} is not configured.`);
    }

    const payload = {
      ...req,
      model: config.model,
    };

    const url = `${config.baseUrl}/chat/completions`;

    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}

export const providers: Record<ProviderName, Provider> = {
  gemini: new BaseProviderAdapter("gemini"),
  groq: new BaseProviderAdapter("groq"),
  openrouter: new BaseProviderAdapter("openrouter"),
};
