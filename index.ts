/**
 * Rozalia AI Provider Extension
 *
 * Registers one or more OpenAI-compatible providers for the Pi coding agent,
 * connecting to Rozalia AI servers. Each server gets its own provider entry
 * named after its hostname, so models are unambiguous in the picker:
 *   rozalia-ai-zygoon-pl/claude-sonnet-4-6
 *   rozalia-localhost-1234/deepseek-r1
 *
 * Configuration (in order of precedence):
 *   1. /login → OAuth flow (stores baseUrl + apiKey in ~/.pi/agent/auth.json)
 *   2. ROZALIA_BASE_URL  env var (default: https://ai.zygoon.pl/v1)
 *   3. ROZALIA_API_KEY   env var
 *
 * Usage:
 *   # Quick: set env vars (registers one provider from the default URL)
 *   export ROZALIA_API_KEY="your-api-key"
 *   pi
 *
 *   # Full: use /login to configure server URL + API key interactively
 *   pi
 *   /login
 *   → pick "Rozalia"
 *   → enter server URL (default: https://ai.zygoon.pl/v1)
 *   → enter API key
 *
 *   # Multiple servers — run /login for each one:
 *   pi
 *   /login  → https://ai.zygoon.pl/v1
 *   /login  → http://localhost:1234
 *   → two providers: rozalia-ai-zygoon-pl + rozalia-localhost-1234
 *
 *   # Point to a custom server
 *   ROZALIA_BASE_URL="https://my-server.example.com/v1" \
 *   ROZALIA_API_KEY="my-key" \
 *   pi
 */

import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Credential payload (stored in OAuth refresh field)
// ---------------------------------------------------------------------------

interface CredsPayload {
  baseUrl: string;
  apiKey: string;
}

function encodeCreds(payload: CredsPayload): OAuthCredentials {
  return {
    refresh: JSON.stringify(payload),
    access: payload.apiKey,
    expires: Date.now() + 24 * 60 * 60 * 1000,
  };
}

function decodeCreds(creds: OAuthCredentials): CredsPayload {
  try {
    const parsed = JSON.parse(creds.refresh ?? "");
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : (creds.access ?? ""),
    };
  } catch {
    return { baseUrl: "", apiKey: creds.access ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Configuration fallback (env vars)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://ai.zygoon.pl/v1";

function getEnvBaseUrl(): string {
  return process.env.ROZALIA_BASE_URL ?? DEFAULT_BASE_URL;
}

function getEnvApiKey(): string | undefined {
  return process.env.ROZALIA_API_KEY;
}

// ---------------------------------------------------------------------------
// Provider name derivation from base URL
// ---------------------------------------------------------------------------

/**
 * Derive a safe, readable provider name from a base URL.
 *
 * https://ai.zygoon.pl/v1    → rozalia-ai-zygoon-pl
 * http://localhost:1234       → rozalia-localhost-1234
 * https://10.0.0.5:9000      → rozalia-10-0-0-5-9000
 */
function deriveProviderName(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    const port = url.port ? `-${url.port}` : "";
    const slug = host.replace(/\./g, "-").replace(/:/g, "-");
    return `rozalia-${slug}${port}`;
  } catch {
    // Fallback for malformed URLs: sanitize the raw string
    const sanitized = (baseUrl ?? "").replace(/[^a-z0-9]/gi, "-");
    return `rozalia-${sanitized}`;
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

async function fetchModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<ProviderModelConfig[]> {
  const url = new URL("/v1/models", baseUrl);

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

  const entries = data.data ?? data.models ?? [];
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected /v1/models response format");
  }

  return entries.map((entry) => mapModel(entry));
}

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
// OAuth login / refresh — per-server
// ---------------------------------------------------------------------------

function createLoginFlow(
  defaultUrl: string,
  defaultApiKey: string | undefined,
): (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials> {
  return async (callbacks: OAuthLoginCallbacks) => {
    const inputUrl = await callbacks.onPrompt({
      message: `Enter Rozalia server URL (press Enter for ${defaultUrl}):`,
    });
    const trimmedUrl = inputUrl.trim();
    const baseUrl = trimmedUrl ? trimmedUrl : defaultUrl;

    const inputKey = await callbacks.onPrompt({
      message: `Enter API key (optional — press Enter to skip):`,
    });
    const apiKey = inputKey.trim() || defaultApiKey || "";

    // Verify connectivity and fetch models
    try {
      const controller = new AbortController();
      await fetchModels(baseUrl, apiKey, controller.signal);
    } catch {
      // Still register — models will be discovered later or show fallback
    }

    return encodeCreds({ baseUrl, apiKey });
  };
}

function createRefreshTokenFlow(
  baseUrl: string,
  apiKey: string | undefined,
): (creds: OAuthCredentials, signal: AbortSignal) => Promise<OAuthCredentials> {
  return async (_creds: OAuthCredentials, _signal: AbortSignal) => {
    // Re-discover models from stored server
    try {
      const controller = new AbortController();
      await fetchModels(baseUrl, apiKey, controller.signal);
    } catch {
      // network blip — keep creds, retry on next call
    }
    // Return creds unchanged (they already contain the correct payload)
    return _creds;
  };
}

function createGetApiKeyFlow(): (creds: OAuthCredentials) => string {
  return (creds: OAuthCredentials) => {
    const payload = decodeCreds(creds);
    return payload.apiKey || "";
  };
}

// ---------------------------------------------------------------------------
// Provider registration helper
// ---------------------------------------------------------------------------

async function registerRozaliaProvider(
  pi: ExtensionAPI,
  baseUrl: string,
  apiKey: string | undefined,
  providerName: string,
  oauthBlock: {
    name: string;
    login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
    refreshToken: (creds: OAuthCredentials, signal: AbortSignal) => Promise<OAuthCredentials>;
    getApiKey: (creds: OAuthCredentials) => string;
  },
): Promise<void> {
  let models: ProviderModelConfig[];
  try {
    const controller = new AbortController();
    models = await fetchModels(baseUrl, apiKey, controller.signal);
    if (models.length === 0) {
      models = getFallbackModels();
    }
  } catch {
    models = getFallbackModels();
  }

  const config: Record<string, unknown> = {
    name: `Rozalia (${providerName})`,
    baseUrl,
    api: "openai-completions",
    models,
    oauth: oauthBlock,
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  pi.registerProvider(providerName, config);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const envBaseUrl = getEnvBaseUrl();
  const envApiKey = getEnvApiKey();
  const providerName = deriveProviderName(envBaseUrl);

  // Create per-server OAuth flow
  const oauthBlock = {
    name: "Rozalia",
    login: createLoginFlow(envBaseUrl, envApiKey),
    refreshToken: createRefreshTokenFlow(envBaseUrl, envApiKey),
    getApiKey: createGetApiKeyFlow(),
  };

  // Initial stub registration so "Rozalia" appears in /login selector
  pi.registerProvider(providerName, {
    name: `Rozalia (${providerName})`,
    baseUrl: envBaseUrl,
    api: "openai-completions",
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if env vars provide a key, register eagerly so models
  // appear without waiting for the next /login refresh tick.
  if (envApiKey) {
    try {
      await registerRozaliaProvider(pi, envBaseUrl, envApiKey, providerName, oauthBlock);
    } catch {
      // ignore — will retry on next call
    }
  }
}
