import {
  gatewayConfig,
  type ModelAlias,
  type ProviderName,
  type RoutingStrategy,
} from "./config/models";
import { providers } from "./providers";
import type { Provider } from "./providers/types";
import type { Bindings } from "./types/env";

const latencyHistory: Map<ProviderName, number[]> = new Map();
const MAX_SAMPLES = 20;

export function recordLatency(provider: ProviderName, latencyMs: number): void {
  const samples = latencyHistory.get(provider) || [];
  samples.push(latencyMs);
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
  latencyHistory.set(provider, samples);
}

export function getAverageLatency(provider: ProviderName): number {
  const samples = latencyHistory.get(provider);
  if (!samples || samples.length === 0) {
    return Infinity;
  }
  const sum = samples.reduce((acc, curr) => acc + curr, 0);
  return sum / samples.length;
}

export function resetLatencyStats(): void {
  latencyHistory.clear();
}

export interface RouterResolution {
  provider?: Provider;
  error?: {
    status: 503;
    message: string;
    type: string;
    code: string;
  };
}

export function resolveProvider(
  modelAlias: ModelAlias,
  env: Bindings,
  strategyOverride?: RoutingStrategy
): RouterResolution {
  const candidateNames = gatewayConfig.aliases[modelAlias];
  if (!candidateNames || candidateNames.length === 0) {
    return {
      error: {
        status: 503,
        message: `No providers defined for model '${modelAlias}'.`,
        type: "api_error",
        code: "service_unavailable",
      },
    };
  }

  // Filter candidates that are configured in the current environment
  const configuredNames = candidateNames.filter((name) =>
    providers[name].isConfigured(env)
  );

  if (configuredNames.length === 0) {
    return {
      error: {
        status: 503,
        message: `No configured providers available for model '${modelAlias}'.`,
        type: "api_error",
        code: "service_unavailable",
      },
    };
  }

  const strategy = strategyOverride || gatewayConfig.strategy;

  if (strategy === "lowest_latency") {
    // Sort configured candidates by rolling average latency
    const sorted = [...configuredNames].sort((a, b) => {
      const avgA = getAverageLatency(a);
      const avgB = getAverageLatency(b);
      if (avgA === avgB) {
        // preserve original fallback order if latencies are identical/unrecorded
        return candidateNames.indexOf(a) - candidateNames.indexOf(b);
      }
      return avgA - avgB;
    });

    return { provider: providers[sorted[0]] };
  }

  // Default: fallback_order (pick the first configured provider)
  return { provider: providers[configuredNames[0]] };
}
