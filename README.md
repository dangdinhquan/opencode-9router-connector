# opencode-9router-plugin

A production-ready OpenCode plugin that auto-connects to any OpenAI-compatible API and auto-discovers available models from `GET /v1/models`.

The plugin maps discovered models into OpenCode `provider.models` format, preserves native model IDs from `/v1/models` (for example `gh/gpt-5.3-codex`), enriches capability/token metadata from `https://models.dev/api.json`, supports include/exclude filtering by model ID, and safely falls back to static models when discovery cannot run.

## Installation

Add the plugin to your OpenCode config file (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@dendaio/opencode-9router-plugin"]
}
```

OpenCode will automatically resolve and load the plugin on next startup.

### Why `provider` is required

OpenCode only calls a plugin's `provider.models` hook for providers that appear in the `provider` section of `opencode.json` (note: the key is singular `"provider"`, not `"providers"`). Without an entry there, the models hook is silently skipped and no models are discovered.

The plugin handles this automatically: when you run `opencode auth login` and complete the 9router login flow, the plugin writes `"9router": {}` into `opencode.json` for you. After that, restart opencode once and `opencode models` will show the 9router models.

If you prefer to add it manually (or if the auto-registration does not trigger), add the entry yourself:

```json
{
  "plugin": ["@dendaio/opencode-9router-plugin"],
  "provider": {
    "9router": {}
  }
}
```

## Local Development

Use this workflow when developing or testing the plugin directly from source (e.g. inside a Codespace or local clone of this repo).

> **Note**: OpenCode installs npm plugins using its own internal resolver (not `npm link`). For local development you must point the config at your built file directly.

### 1. Install dependencies and build

```bash
npm install -g opencode-ai
npm install
npm run build
```

### 2. Configure OpenCode to load from the local build

Add the **absolute path** to the built entrypoint in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/workspaces/opencode-9router-connector/dist/index.js"],
  "provider": {
    "9router": {}
  }
}
```

### 3. Watch mode for active development

In one terminal, start the incremental rebuild watcher:

```bash
npm run dev
```

In another terminal, run OpenCode:

```bash
opencode
```

Changes to source files are rebuilt automatically; restart OpenCode to pick them up.

### 4. Verify the plugin loaded

Inside OpenCode, run:

```
/connect 9router
/models
```

You should see the `9router` provider and its discovered models.

### Debug logging

```bash
OPENCODE_LOG=debug opencode
```

## Publish to npm (GitHub Actions)

This repository includes a workflow at:

- `.github/workflows/publish-npm.yml`

The workflow publishes to npm when:

- a Git tag matching `v*` is pushed (for example `v1.0.0`), or
- triggered manually via `workflow_dispatch`.

Required repository secret:

- `NPM_TOKEN`: npm automation token with publish permission for `opencode-9router-plugin`.

## Environment variables

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Required by default:

- `ROUTER9_API_KEY`: API key used for model discovery and auth hook loading.

You can change the env var name with `apiKeyEnvName` in plugin options.

## OpenCode config sample (`~/.config/opencode/opencode.json`)

> The provider key must match the plugin `providerId` (default: `9router`).

```jsonc
{
  "plugin": ["@dendaio/opencode-9router-plugin"],
  "provider": {
    "9router": {
      // Either field can be used; plugin resolves api first, then baseURL.
      // Defaults to https://llm-gateway.denda.cloud/v1 if not specified.
      "api": "https://llm-gateway.denda.cloud/v1",
      // "baseURL": "https://llm-gateway.denda.cloud/v1",
      "models": {
        // Static fallback models. Dynamic discovery overrides by model id.
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

## Usage

```ts
import plugin, { createOpenAICompatibleModelsPlugin } from "opencode-9router-plugin";

// Use default instance
export default {
  plugin: [plugin]
};

// Or customize
const customPlugin = createOpenAICompatibleModelsPlugin({
  providerId: "9router",
  defaultBaseURL: "https://llm-gateway.denda.cloud/v1",
  apiKeyEnvName: "ROUTER9_API_KEY",
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192,
  modelEnrichment: {
    enabled: true,
    catalogURL: "https://models.dev/api.json",
    timeoutMs: 3000,
    cacheTtlMs: 600000,
    overrideUpstream: false,
    providerAliases: { gh: "github", cx: "openai" }
  },
  includePrefixes: ["gh", "cx", "cc"],
  includeModelIdRegex: /^gpt|^o\d/i,
  excludeModelIdRegex: /audio|embedding/i
});
```

## Interactive login prompts (`/connect` / `opencode auth login`)

When you log in with the plugin provider (`9router` by default), OpenCode will prompt for:

- API key (built-in API auth prompt)
- Base URL (plugin auth prompt)

The base URL is persisted to:

- `~/.config/opencode/opencode-9router-plugin.<providerId>.json`

At runtime, base URL resolution order is:

1. `provider.api`
2. `provider.baseURL`
3. persisted base URL from login prompt
4. `defaultBaseURL` plugin option

## models.dev enrichment

`GET /v1/models` often omits capability and limit details. This plugin enriches discovered models using `https://models.dev/api.json`, with indexed lookup and provider alias mapping.

Lookup flow (in order):

1. provider-specific exact match
2. provider-specific normalized match (`normalizeModelKey`)
3. global exact match (only when unambiguous)
4. global normalized match (only when unambiguous)

Provider prefix mapping is configurable via `modelEnrichment.providerAliases` (for example `gh -> github`, `cx -> openai`).

When upstream `/v1/models` already provides fields such as `context_length`, `capabilities`, or `max_output_tokens`, they are used by default. Set `modelEnrichment.overrideUpstream: true` to force models.dev values to override upstream metadata.

Set `modelEnrichment.enabled: false` to disable the entire enrichment sub-system (no catalog fetch will be performed).

If no models.dev match is found, safe defaults are used:

- `attachment: false`
- `temperature: true`
- `tool_call: true`
- `reasoning: true` only for inferred `o1` and `o3` families
- `limit.context` and `limit.output` from plugin defaults

## Troubleshooting

- **401 Unauthorized**: verify `ROUTER9_API_KEY` (or your configured `apiKeyEnvName`) is set and valid.
- **404 Not Found**: check your base URL. The plugin calls:
  - `{baseURL}/models` when base URL already ends with `/v1`
  - `{baseURL}/v1/models` otherwise
- **CORS errors**: browser-only environments may block direct API calls; run via a trusted backend/proxy.
- **No discovered models**: plugin will keep static `provider.models` as fallback when API key is missing, request fails, or schema is invalid.

## License

MIT
