# pi-rozalia

An extension for the [Pi coding agent](https://github.com/microsoft/pi-coding-agent) that connects to a [Rozalia AI](https://ai.zygoon.pl) server via the OpenAI-compatible Chat Completions API.

## Prerequisites

1. **Pi Coding Agent** installed.
2. A **Rozalia AI server** running and accessible.

## Installation

```bash
pi install npm:pi-rozalia
```

## Configuration

### Interactive setup (recommended)

Use Pi's built-in `/login` command to configure your server and API key:

```bash
pi
/login
→ pick "Rozalia"
→ enter server URL (default: https://ai.zygoon.pl/v1)
→ enter API key (optional)
```

The server URL and API key are stored in `~/.pi/agent/auth.json` and reused on subsequent logins.

### Environment variables (alternative)

| Variable | Description | Default |
|----------|-------------|---------|
| `ROZALIA_BASE_URL` | Rozalia AI server base URL | `https://ai.zygoon.pl/v1` |
| `ROZALIA_API_KEY` | API key for authentication | *(none)* |

```bash
export ROZALIA_API_KEY="your-api-key"
```

### Custom server

Point to any OpenAI-compatible server:

```bash
ROZALIA_BASE_URL="https://my-server.example.com/v1" \
ROZALIA_API_KEY="my-key" \
pi
```

## Usage

1. **Launch Pi** — the provider loads automatically on startup.

   ```bash
   pi
   ```

2. **Select a Model** — use `/model` or `Ctrl+P` to pick from the discovered models.

## How It Works

On startup, the extension fetches the model list from the server's `/v1/models` endpoint and registers each model with Pi. If discovery fails, a single fallback model is registered so you can still try to connect.

The `/login` flow stores your server URL and API key in Pi's credential store (`~/.pi/agent/auth.json`). On subsequent logins the stored URL is pre-filled, so you only need to re-enter it if your server changes.

## Known Limitations

- **Models stay listed after `/logout`.** Pi's extension API has no logout callback/event for OAuth-backed providers, so this extension has no way to detect that `/logout` ran and revert the provider to its empty stub. The model list only clears on the next Pi restart. This is a Pi platform limitation, not something this extension can currently work around.

## TODO

- [ ] Multi-server support — register each configured server as its own provider with a derived name (e.g. `rozalia-localhost-1234`), so models from different servers are unambiguous in the picker
- [ ] Model discovery health check — skip servers that fail to respond rather than showing fallback models
- [ ] `ROZALIA_TIMEOUT` env var — configure model discovery timeout (currently hardcoded to 5s)
- [ ] Support for `ROZALIA_MODELS` env var — allow overriding the discovered model list with a static list

## License

[MIT](LICENSE) — © 2026 Maciej Borzecki
