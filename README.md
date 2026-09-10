# pi-rozalia

An extension for the [Pi coding agent](https://github.com/microsoft/pi-coding-agent) that connects to one or more [Rozalia AI](https://ai.zygoon.pl) servers via the OpenAI-compatible Chat Completions API.

Each server is registered as a separate provider named after its hostname, so models from different servers are unambiguous in the picker:

```
rozalia-ai-zygoon-pl/claude-sonnet-4-6
rozalia-localhost-1234/deepseek-r1
```

## Prerequisites

1. **Pi Coding Agent** installed.
2. One or more **Rozalia AI servers** running and accessible.

## Installation

```bash
pi install npm:pi-rozalia
```

## Configuration

### Single server — interactive setup (recommended)

Use Pi's built-in `/login` command:

```bash
pi
/login
→ pick "Rozalia"
→ enter server URL (default: https://ai.zygoon.pl/v1)
→ enter API key (optional)
```

### Single server — environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ROZALIA_BASE_URL` | Rozalia AI server base URL | `https://ai.zygoon.pl/v1` |
| `ROZALIA_API_KEY` | API key for authentication | *(none)* |

```bash
export ROZALIA_API_KEY="your-api-key"
```

### Multiple servers — config file

Create `~/.pi/agent/rozalia-servers.json`:

```json
{
  "servers": [
    { "url": "https://ai.zygoon.pl/v1", "apiKey": "key1" },
    { "url": "http://localhost:1234", "apiKey": "key2" }
  ]
}
```

Each server gets its own provider named after its hostname:

| URL | Provider name |
|-----|---------------|
| `https://ai.zygoon.pl/v1` | `rozalia-ai-zygoon-pl` |
| `http://localhost:1234` | `rozalia-localhost-1234` |
| `https://10.0.0.5:9000` | `rozalia-10-0-0-5-9000` |

When the config file exists and has servers listed, it takes precedence over env vars and `/login`.

## Usage

1. **Launch Pi** — providers load automatically on startup.

   ```bash
   pi
   ```

2. **Select a Model** — use `/model` or `Ctrl+P` to pick from the discovered models. Models are prefixed with the provider name (e.g. `rozalia-ai-zygoon-pl/...`).

## How It Works

On startup, the extension discovers the configured server(s) and fetches the model list from each server's `/v1/models` endpoint. Each server is registered as a separate provider with a name derived from its hostname.

If discovery fails for a server, a single fallback model is registered so you can still try to connect.

The `/login` flow stores your server URL and API key in Pi's credential store (`~/.pi/agent/auth.json`). On subsequent logins the stored URL is pre-filled, so you only need to re-enter it if your server changes.

## License

[MIT](LICENSE) — © 2026 Maciej Borzecki
