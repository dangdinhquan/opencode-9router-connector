# opencode-9router-plugin

A production-ready OpenCode plugin that auto-connects to any OpenAI-compatible API and auto-discovers available models from `GET /v1/models`.

The plugin maps discovered models into OpenCode `provider.models` format, supports include/exclude filtering by model ID, and safely falls back to static models when discovery cannot run.

## Installation

```bash
npm install opencode-9router-plugin
```

## Environment variables

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Required by default:

- `MYOPENAI_API_KEY`: API key used for model discovery and auth hook loading.

You can change the env var name with `apiKeyEnvName` in plugin options.

## OpenCode provider config example

> The provider key must match the plugin `providerId` (default: `myopenai`).

```ts
providers: {
  myopenai: {
    // Either field can be used; plugin resolves api first, then baseURL.
    api: "https://api.openai.com/v1",
    // baseURL: "https://api.openai.com/v1",
    models: {
      // Static fallback models. Dynamic discovery overrides by model id.
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        family: "gpt-4o",
        release_date: "2024-07-18",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 }
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
  plugins: [plugin]
};

// Or customize
const customPlugin = createOpenAICompatibleModelsPlugin({
  providerId: "myopenai",
  defaultBaseURL: "https://api.openai.com/v1",
  apiKeyEnvName: "MYOPENAI_API_KEY",
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192,
  includeModelIdRegex: /^gpt|^o\d/i,
  excludeModelIdRegex: /audio|embedding/i
});
```

## Capability defaults

OpenAI-compatible `/models` responses do not expose full capability metadata.

This plugin applies safe defaults when converting models:

- `attachment: false`
- `temperature: true`
- `tool_call: true`
- `reasoning: true` only for `o1` and `o3` families
- `limit.context` and `limit.output` come from plugin options defaults

## Troubleshooting

- **401 Unauthorized**: verify `MYOPENAI_API_KEY` (or your configured `apiKeyEnvName`) is set and valid.
- **404 Not Found**: check your base URL. The plugin calls:
  - `{baseURL}/models` when base URL already ends with `/v1`
  - `{baseURL}/v1/models` otherwise
- **CORS errors**: browser-only environments may block direct API calls; run via a trusted backend/proxy.
- **No discovered models**: plugin will keep static `provider.models` as fallback when API key is missing, request fails, or schema is invalid.

## License

MIT
