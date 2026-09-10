/**
 * Rozalia AI Provider Extension
 *
 * Registers an OpenAI-compatible provider for the Pi coding agent,
 * connecting to a Rozalia AI server.
 *
 * Configuration (in order of precedence):
 *   1. /login → OAuth flow (stores baseUrl + apiKey in ~/.pi/agent/auth.json)
 *   2. ROZALIA_BASE_URL  env var (default: https://ai.zygoon.pl/v1)
 *   3. ROZALIA_API_KEY   env var
 *
 * Usage:
 *   # Quick: set env vars
 *   export ROZALIA_API_KEY="your-api-key"
 *   pi
 *
 *   # Full: use /login to configure server URL + API key interactively
 *   pi
 *   /login
 *   → pick "rozalia"
 *   → enter server URL (default: https://ai.zygoon.pl/v1)
 *   → enter API key
 *
 *   # Point to a custom server
 *   ROZALIA_BASE_URL="https://my-server.example.com/v1" \
 *   ROZALIA_API_KEY="my-key" \
 *   pi
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Credential payload (stored in OAuth refresh field).
// NOTE: the 24h expiry previously baked into encodeCreds is removed — it caused
// Pi's OAuth machinery to call refreshToken on every token, which was a no-op
// pass-through. Credentials now carry no artificial expiry; Pi manages lifetime.
// ---------------------------------------------------------------------------

interface CredsPayload {
  baseUrl: string;
  apiKey: string;
}

function encodeCreds(payload: CredsPayload): OAuthCredentials {
  return {
    refresh: JSON.stringify(payload),
    access: payload.apiKey,
    // No artificial expiry — Pi's OAuth machinery manages token lifetime.
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

  // Use a manual timeout via AbortController for Node.js compatibility
  // (AbortSignal.timeout / AbortSignal.any may not be available on older versions)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal, headers });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Model discovery failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
      models?: Array<Record<string, unknown>>;
    };

    const entries = data.data ?? data.models ?? [];
    if (!Array.isArray(entries)) {
      throw new Error("Unexpected /v1/models response format");
    }

    return entries.map((entry) => mapModel(entry));
  } finally {
    clearTimeout(timer);
  }
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

  // context_length may be nested inside a custom provider object (e.g. rozalia.context_length)
  const customObj = entry.rozalia as Record<string, unknown> | undefined;
  const contextWindow =
    (entry.context_window as number) ??
    (entry.context as number) ??
    (entry.max_context_length as number) ??
    (entry.maxContextLength as number) ??
    (customObj?.context_length as number) ??
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

function logDiscoveryError(baseUrl: string, error: unknown): void {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(
    `[rozalia] Model discovery failed for ${baseUrl} — only the fallback "unknown" model will be registered. Original error:`,
    message,
  );
}

// ---------------------------------------------------------------------------
// Provider registration helper
// ---------------------------------------------------------------------------

async function registerRozaliaProvider(
  pi: ExtensionAPI,
  creds: CredsPayload,
  oauthBlock: {
    name: string;
    login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
    refreshToken: (creds: OAuthCredentials, signal: AbortSignal) => Promise<OAuthCredentials>;
    getApiKey: (creds: OAuthCredentials) => string;
  },
): Promise<void> {
  const { baseUrl, apiKey } = creds;
  if (!baseUrl) return;

  let models: ProviderModelConfig[];
  try {
    const controller = new AbortController();
    models = await fetchModels(baseUrl, apiKey, controller.signal);
    if (models.length === 0) {
      console.error(
        `[rozalia] No models returned by ${baseUrl} — only the fallback "unknown" model will be registered.`,
      );
      models = getFallbackModels();
    }
  } catch (error) {
    logDiscoveryError(baseUrl, error);
    models = getFallbackModels();
  }

  const config: Record<string, unknown> = {
    name: "Rozalia",
    baseUrl,
    api: "openai-completions",
    models,
    oauth: oauthBlock,
    // Ensure Pi injects Authorization: Bearer <apiKey> on every request.
    // Without this, an OAuth credential whose apiKey is empty ("") leaves
    // the OpenAI SDK with no key and omits the header entirely.
    authHeader: true,
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  // Unregister first so Pi replaces the stub (empty models) with
  // the real model list. Without this, registerProvider keeps
  // the stub's models: [] on an already-registered provider.
  try {
    pi.unregisterProvider("rozalia");
  } catch {
    // not previously registered; ignore
  }

  pi.registerProvider("rozalia", config);
}

// ---------------------------------------------------------------------------
// OAuth login / refresh
// ---------------------------------------------------------------------------

/**
 * Create a login flow that captures `pi` in the closure so it can
 * call registerRozaliaProvider before returning the credential.
 */
function createLoginFlow(
  defaultUrl: string,
  defaultApiKey: string | undefined,
  pi: ExtensionAPI,
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

    const creds: CredsPayload = { baseUrl, apiKey };

    // Verify connectivity and fetch models
    try {
      const controller = new AbortController();
      await fetchModels(baseUrl, apiKey, controller.signal);
    } catch {
      // Still register — models will be discovered later or show fallback
    }

    // Actually register the provider so models appear immediately
    const oauthBlock = buildOauthBlock(defaultUrl, defaultApiKey, pi);
    await registerRozaliaProvider(pi, creds, oauthBlock);

    return encodeCreds(creds);
  };
}

// ---------------------------------------------------------------------------
// OAuth block factory (shared between /login and startup)
// ---------------------------------------------------------------------------

function buildOauthBlock(
  defaultUrl: string,
  defaultApiKey: string | undefined,
  pi: ExtensionAPI,
) {
  return {
    name: "Rozalia",
    login: createLoginFlow(defaultUrl, defaultApiKey, pi),
    refreshToken: async (creds: OAuthCredentials, signal: AbortSignal) => {
      const payload = decodeCreds(creds);
      if (!payload.baseUrl) return creds;
      // Re-register with fresh models so the picker updates without restart
      try {
        await registerRozaliaProvider(pi, payload, {
          name: "Rozalia",
          login: createLoginFlow(defaultUrl, defaultApiKey, pi),
          refreshToken: async (c: OAuthCredentials, s: AbortSignal) =>
            refreshTokenRozalia(c, s, payload, defaultUrl, defaultApiKey, pi),
          getApiKey: (c: OAuthCredentials) => decodeCreds(c).apiKey || "",
        });
      } catch {
        // network blip — keep creds, retry on next call
      }
      return encodeCreds(payload);
    },
    getApiKey: (creds: OAuthCredentials) => decodeCreds(creds).apiKey || "",
  };
}

async function refreshTokenRozalia(
  creds: OAuthCredentials,
  _signal: AbortSignal,
  _payload: CredsPayload,
  _defaultUrl: string,
  _defaultApiKey: string | undefined,
  _pi: ExtensionAPI,
): Promise<OAuthCredentials> {
  return encodeCreds(decodeCreds(creds));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const envBaseUrl = getEnvBaseUrl();
  const envApiKey = getEnvApiKey();

  // Capture pi in a closure so the login flow can call registerRozaliaProvider
  // (Pi only passes callbacks to login, not pi).
  const oauthBlock = buildOauthBlock(envBaseUrl, envApiKey, pi);

  // Initial stub registration so "Rozalia" appears in /login selector.
  // Credentials are resolved by Pi's OAuth machinery at request time — we no
  // longer read ~/.pi/agent/auth.json directly (see commit history for why).
  pi.registerProvider("rozalia", {
    name: "Rozalia",
    baseUrl: envBaseUrl,
    api: "openai-completions",
    authHeader: true,
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if the API key is provided via env var, register eagerly so
  // models appear without waiting for /login.
  if (envApiKey) {
    try {
      await registerRozaliaProvider(pi, { baseUrl: envBaseUrl, apiKey: envApiKey }, oauthBlock);
    } catch {
      // ignore — will retry on next call
    }
  }
}
