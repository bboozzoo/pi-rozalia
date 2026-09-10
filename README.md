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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ROZALIA_BASE_URL` | Rozalia AI server base URL | `https://ai.zygoon.pl/v1` |
| `ROZALIA_API_KEY` | API key for authentication | *(none — required if auth is enabled)* |

```bash
export ROZALIA_API_KEY="your-api-key"
```

### Custom Server

Point to any OpenAI-compatible server:

```bash
export ROZALIA_BASE_URL="https://my-server.example.com/v1"
export ROZALIA_API_KEY="my-key"
```

## Usage

1. **Launch Pi** — the provider loads automatically on startup.

   ```bash
   pi
   ```

2. **Select a Model** — use `/model` or `Ctrl+P` to pick from the discovered models.

## How It Works

On startup, the extension fetches the model list from the server's `/v1/models` endpoint and registers each model with Pi. If discovery fails, a single fallback model is registered so you can still try to connect.

## License

MIT
