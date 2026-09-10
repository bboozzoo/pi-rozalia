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

import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

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
      models = getFallbackModels();
    }
  } catch {
    models = getFallbackModels();
  }

  const config: Record<string, unknown> = {
    name: "Rozalia",
    baseUrl,
    api: "openai-completions",
    models,
    oauth: oauthBlock,
  };

  if (apiKey) {
    config.apiKey = apiKey;
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
): (pi: ExtensionAPI, callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials> {
  return async (pi: ExtensionAPI, callbacks: OAuthLoginCallbacks) => {
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
    await registerRozaliaProvider(pi, creds, {
      name: "Rozalia",
      login: createLoginFlow(defaultUrl, defaultApiKey),
      refreshToken: async (creds: OAuthCredentials, signal: AbortSignal) => {
        const payload = decodeCreds(creds);
        try {
          const ctrl = new AbortController();
          await fetchModels(payload.baseUrl, payload.apiKey, ctrl.signal);
        } catch {
          // network blip
        }
        return creds;
      },
      getApiKey: (creds: OAuthCredentials) => decodeCreds(creds).apiKey || "",
    });

    return encodeCreds(creds);
  };
}

async function refreshTokenRozalia(
  creds: OAuthCredentials,
  _signal: AbortSignal,
): Promise<OAuthCredentials> {
  const payload = decodeCreds(creds);
  if (!payload.baseUrl) return creds;

  // Re-discover models from stored server
  try {
    const controller = new AbortController();
    await fetchModels(payload.baseUrl, payload.apiKey, controller.signal);
  } catch {
    // network blip — keep creds, retry on next call
  }

  return encodeCreds(payload);
}

function getApiKeyRozalia(creds: OAuthCredentials): string {
  const payload = decodeCreds(creds);
  return payload.apiKey || "";
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const envBaseUrl = getEnvBaseUrl();
  const envApiKey = getEnvApiKey();

  // Try to restore saved credentials from auth.json.
  // Handles both our custom OAuth format ({ refresh, access }) and
  // Pi's built-in api_key format ({ type: "api_key", key }).
  let storedCreds: CredsPayload | null = null;
  try {
    const authPath = `${process.env.HOME ?? "/"}/.pi/agent/auth.json`;
    const raw = fs.readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const cred = auth["rozalia"] as Record<string, unknown> | undefined;
    if (cred) {
      // Built-in api_key format
      if (cred.type === "api_key" && typeof cred.key === "string" && cred.key) {
        storedCreds = { baseUrl: envBaseUrl, apiKey: cred.key };
      }
      // Custom OAuth format
      else {
        const parsed = decodeCreds(cred as OAuthCredentials);
        if (parsed.baseUrl) storedCreds = parsed;
      }
    }
  } catch {
    // No saved credential — will use env vars or prompt
  }

  const oauthBlock = {
    name: "Rozalia",
    login: createLoginFlow(envBaseUrl, envApiKey),
    refreshToken: async (creds: OAuthCredentials, signal: AbortSignal) => {
      const payload = decodeCreds(creds);
      if (!payload.baseUrl) return creds;
      try {
        const ctrl = new AbortController();
        await fetchModels(payload.baseUrl, payload.apiKey, ctrl.signal);
      } catch {
        // network blip
      }
      return creds;
    },
    getApiKey: (creds: OAuthCredentials) => decodeCreds(creds).apiKey || "",
  };

  // Initial stub registration so "Rozalia" appears in /login selector
  pi.registerProvider("rozalia", {
    name: "Rozalia",
    baseUrl: envBaseUrl,
    api: "openai-completions",
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if env vars OR saved credentials provide a key,
  // register eagerly so models appear without waiting for /login.
  let credsToUse: CredsPayload | null = null;
  if (envApiKey) {
    credsToUse = { baseUrl: envBaseUrl, apiKey: envApiKey };
  } else if (storedCreds?.apiKey) {
    credsToUse = storedCreds;
  }

  if (credsToUse) {
    try {
      await registerRozaliaProvider(pi, credsToUse, oauthBlock);
    } catch {
      // ignore — will retry on next call
    }
  }
}
