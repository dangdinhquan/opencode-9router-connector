# opencode-9router-plugin

OpenCode plugin for 9router and other OpenAI-compatible gateways.

It auto-discovers models from `GET /v1/models`, maps them to OpenCode `provider.models`, enriches metadata from `https://models.dev/api.json`, supports filtering, and falls back to static models when discovery is unavailable.

## Install and use in OpenCode

1) Add plugin to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@dendaio/opencode-9router-plugin"]
}
```

2) Login and set credentials:

```bash
opencode auth login
```

or inside OpenCode:

```
/connect 9router
```

During login, OpenCode asks for:
- API key

3) Restart OpenCode, then verify:

```
/models
```

You should see models under provider `9router`.

## Why `provider` entry matters

OpenCode only calls `provider.models` for providers present in the `provider` section (singular key: `"provider"`).

This plugin auto-registers the provider during login. If needed, add it manually:

```json
{
  "plugin": ["@dendaio/opencode-9router-plugin"],
  "provider": {
    "9router": {}
  }
}
```

## Configuration

Provider key must match plugin provider id (default: `9router`).

```jsonc
{
  "plugin": ["@dendaio/opencode-9router-plugin"],
  "provider": {
    "9router": {
      "api": "https://your-gateway.example/v1",
      "options": {
        "modelEnrichment": {
          "enabled": true,
          "catalogURL": "https://models.dev/api.json",
          "timeoutMs": 3000,
          "cacheTtlMs": 600000,
          "overrideUpstream": false,
          "defaultContextWindow": 128000,
          "defaultMaxOutputTokens": 8192,
          "providerAliases": {
            "gh": "github",
            "cx": "openai",
            "ag": ["google-vertex", "google-vertex-anthropic"]
          }
        },
        "modelFiltering": {
          "includePrefixes": ["gh", "cx", "cc"],
          "excludePrefixes": ["ag"],
          "includeModelIdRegex": "/^(gpt|o\\d)/i",
          "excludeModelIdRegex": "/audio|embedding/i"
        }
      },
      "models": {
        "gpt-4o-mini": {
          "id": "gpt-4o-mini",
          "name": "gpt-4o-mini",
          "family": "gpt-4o",
          "release_date": "2024-07-18",
          "attachment": false,
          "reasoning": false,
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 128000, "output": 8192 }
        }
      }
    }
  }
}
```

## Enrichment behavior

- Runtime enrichment fetches directly from `https://models.dev/api.json` (or your `modelEnrichment.catalogURL`).
- Upstream fields win by default; set `modelEnrichment.overrideUpstream: true` to prefer models.dev values.
- If no match is found, plugin uses safe defaults for capabilities and token limits.

## Model filtering

Use these options under `provider.9router.options.modelFiltering`:
- `includePrefixes`
- `excludePrefixes`
- `includeModelIdRegex`
- `excludeModelIdRegex`

Example: exclude quality suffix variants.

```jsonc
{
  "provider": {
    "9router": {
      "options": {
        "modelFiltering": {
          "excludeModelIdRegex": "(-high|-low|-none|-xhigh)$"
        }
      }
    }
  }
}
```

## Environment variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Default key:
- `ROUTER9_API_KEY`

## Development

Use this workflow for local plugin development from source.

### 1) Install and build

```bash
npm install -g opencode-ai
npm install
npm run build
```

### 2) Point OpenCode to local build

Use absolute path to `dist/index.js` in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/workspaces/opencode-9router-connector/dist/index.js"],
  "provider": {
    "9router": {}
  }
}
```

### 3) Run watch mode

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
opencode
```

Restart OpenCode after rebuilds to pick up new plugin output.

### 4) Verify during development

Inside OpenCode:

```
/connect 9router
/models
```

### 5) Debug logs

```bash
OPENCODE_LOG=debug opencode
```

## Troubleshooting

- **401 Unauthorized**: check `ROUTER9_API_KEY` (or your configured key source) and gateway auth requirements.
- **404 Not Found**: check `provider.9router.api` in `opencode.json`; plugin calls `{api}/models` if URL ends with `/v1`, otherwise `{api}/v1/models`.
- **No discovered models**: plugin keeps static fallback models when fetch fails, schema is invalid, or `provider.9router.api` is missing.

## License

MIT
