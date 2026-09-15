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
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

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

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Discovery timeout (ms) read from ROZALIA_TIMEOUT env var.
 * Falls back to 5s when unset or invalid.
 */
function getDiscoveryTimeoutMs(): number {
  const raw = process.env.ROZALIA_TIMEOUT;
  if (!raw) return DEFAULT_DISCOVERY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISCOVERY_TIMEOUT_MS;
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
  const timer = setTimeout(() => controller.abort(), getDiscoveryTimeoutMs());
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
// TTL cache for model discovery
// ---------------------------------------------------------------------------

let cachedModels: ProviderModelConfig[] = [];
let lastFetchedAt = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve baseUrl and apiKey from Pi's credential context.
 *
 * Priority: oauth credential > env vars.
 * This is called by Pi during its refresh cycle — the credential is the
 * effective configured auth (OAuth stored in ~/.pi/agent/auth.json or
 * env-based API key).
 */
function resolveAuthFromContext(context: RefreshModelsContext): { baseUrl: string; apiKey: string } {
  let baseUrl = getEnvBaseUrl();
  let apiKey = getEnvApiKey();

  const cred = context.credential;
  if (cred?.type === "oauth") {
    const p = decodeCreds(cred as OAuthCredentials);
    if (p.baseUrl) baseUrl = p.baseUrl;
    if (p.apiKey) apiKey = p.apiKey;
  } else if (cred?.type === "api_key" && typeof cred.key === "string") {
    apiKey = apiKey || cred.key;
  }

  return { baseUrl, apiKey };
}

/**
 * The `refreshModels` hook — called by Pi on every refresh cycle (startup,
 * explicit model refresh, etc.). Implements a TTL cache to avoid hammering
 * the server while still responding to real changes within 5 minutes.
 */
async function refreshRozaliaModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  // TTL cache: skip fetch if we have a fresh list and caller didn't force
  if (context.allowNetwork && !context.force && cachedModels.length > 0) {
    const age = Date.now() - lastFetchedAt;
    if (age < MODEL_CACHE_TTL_MS) {
      return cachedModels;
    }
  }

  const { baseUrl, apiKey } = resolveAuthFromContext(context);
  if (!baseUrl) {
    return cachedModels.length > 0 ? cachedModels : getFallbackModels();
  }

  // No API key means the user is logged out — skip fetch, return stub.
  if (!apiKey) {
    return cachedModels.length > 0 ? cachedModels : getFallbackModels();
  }

  try {
    const controller = new AbortController();
    const fetched = await fetchModels(baseUrl, apiKey, controller.signal);
    if (fetched.length > 0) {
      cachedModels = fetched;
      lastFetchedAt = Date.now();
      return fetched;
    }
    return getFallbackModels();
  } catch (error) {
    logDiscoveryError(baseUrl, error);
    // Return cached models if available (don't replace with fallback on transient failure)
    return cachedModels.length > 0 ? cachedModels : getFallbackModels();
  }
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

  // No API key — user is logged out, keep the stub.
  if (!apiKey) return;

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

    // Register the provider — registerRozaliaProvider fetches models once,
    // logging and falling back to a stub on failure.
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
  // Hoist the oauth block so refreshToken can reference it without
  // rebuilding a new object on every refresh. Previously, refreshToken
  // constructed an entirely new OAuth config (including nested login /
  // refreshToken closures) and re-registered — wasteful and confusing.
  const oauthBlock = {
    name: "Rozalia",
    login: createLoginFlow(defaultUrl, defaultApiKey, pi),
    refreshToken: async (creds: OAuthCredentials) => {
      const payload = decodeCreds(creds);
      if (!payload.baseUrl) return creds;
      // Refresh the model list so the picker updates without restart.
      // Reuse this same oauthBlock instead of reconstructing it — only the
      // model list changes, not the auth callbacks.
      try {
        await registerRozaliaProvider(pi, payload, oauthBlock);
      } catch {
        // network blip — keep creds, retry on next call
      }
      return encodeCreds(payload);
    },
    getApiKey: (creds: OAuthCredentials) => decodeCreds(creds).apiKey || "",
  };
  return oauthBlock;
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

  // Register the provider with refreshModels so Pi populates models on startup.
  // The refreshModels hook is called by Pi during its refresh cycle (startup,
  // explicit model refresh, etc.) with the resolved credential — this is the
  // canonical Pi mechanism for dynamic model discovery.
  pi.registerProvider("rozalia", {
    name: "Rozalia",
    baseUrl: envBaseUrl,
    api: "openai-completions",
    authHeader: true,
    models: [], // Stub — refreshModels will populate the real list
    refreshModels: refreshRozaliaModels,
    oauth: oauthBlock,
  });

  // Best-effort: if the API key is provided via env var, register eagerly so
  // models appear immediately without waiting for Pi's refresh cycle.
  if (envApiKey) {
    try {
      await registerRozaliaProvider(pi, { baseUrl: envBaseUrl, apiKey: envApiKey }, oauthBlock);
    } catch {
      // ignore — will retry on next Pi refresh cycle
    }
  }
}
