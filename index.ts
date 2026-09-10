/**
 * Rozalia AI Provider Extension
 *
 * Registers an OpenAI-compatible provider for the Pi coding agent,
 * connecting to a Rozalia AI server.
 *
 * Configuration:
 *   ROZALIA_BASE_URL  — server base URL (default: https://ai.zygoon.pl/v1)
 *   ROZALIA_API_KEY   — API key for authentication
 *
 * Usage:
 *   export ROZALIA_API_KEY="your-api-key"
 *   pi                          # provider loads automatically
 *
 *   # Or use a custom server:
 *   export ROZALIA_BASE_URL="https://my-server.example.com/v1"
 *   export ROZALIA_API_KEY="my-key"
 *   pi
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://ai.zygoon.pl/v1";

function getBaseUrl(): string {
  return process.env.ROZALIA_BASE_URL ?? DEFAULT_BASE_URL;
}

function getApiKey(): string | undefined {
  return process.env.ROZALIA_API_KEY;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/** Fetch models from the server's /v1/models endpoint. */
async function fetchModels(baseUrl: string, signal: AbortSignal): Promise<ProviderModelConfig[]> {
  const url = new URL("/v1/models", baseUrl);
  const apiKey = getApiKey();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const timeout = AbortSignal.timeout(5_000);
  const merged = AbortSignal.any([signal, timeout]);

  const response = await fetch(url.toString(), { signal: merged, headers });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model discovery failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    data?: Array<Record<string, unknown>>;
    models?: Array<Record<string, unknown>>;
  };

  // Support both paginated (data) and flat (models) response shapes
  const entries = data.data ?? data.models ?? [];
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected /v1/models response format");
  }

  return entries.map((entry) => mapModel(entry));
}

/** Map a provider-agnostic model entry to Pi's ProviderModelConfig. */
function mapModel(entry: Record<string, unknown>): ProviderModelConfig {
  const id =
    (entry.id as string) ??
    (entry.modelId as string) ??
    (entry.model_id as string) ??
    (entry.root as string) ??
    "unknown";

  const name =
    (entry.name as string) ??
    (entry.displayName as string) ??
    (entry.display_name as string) ??
    id;

  const contextWindow =
    (entry.context_window as number) ??
    (entry.context as number) ??
    (entry.max_context_length as number) ??
    (entry.maxContextLength as number) ??
    128_000;

  const maxTokens =
    (entry.max_tokens as number) ??
    (entry.maxTokens as number) ??
    (entry.max_completion_tokens as number) ??
    8_192;

  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/** Fallback models when discovery fails or returns nothing. */
function getFallbackModels(): ProviderModelConfig[] {
  return [
    {
      id: "unknown",
      name: "Rozalia Model (discovery failed)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  ];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  const apiKey = getApiKey();

  let models: ProviderModelConfig[];

  try {
    const controller = new AbortController();
    models = await fetchModels(baseUrl, controller.signal);
    if (models.length === 0) {
      models = getFallbackModels();
    }
  } catch {
    models = getFallbackModels();
  }

  const providerConfig: Record<string, unknown> = {
    baseUrl,
    api: "openai-completions",
    models,
  };

  if (apiKey) {
    providerConfig.apiKey = apiKey;
  }

  pi.registerProvider("rozalia", providerConfig);
}
