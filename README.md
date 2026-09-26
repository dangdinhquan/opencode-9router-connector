# opencode-9router-plugin

OpenCode plugin for 9router, Omniroute, and other OpenAI-compatible gateways.

It auto-discovers models from `GET /v1/models`, maps them to OpenCode `provider.models`, enriches metadata from `https://models.dev/api.json`, supports filtering, and falls back to static models when discovery fails.

## Compatibility

This plugin is compatible with:

- OpenCode (including OpenCode v2)
- Omniroute
- 9router
- Other gateways exposing an OpenAI-compatible `/v1/models` endpoint

The package exports a default plugin definition with the required `id` and `setup`/`effect` entry points for OpenCode v2. It also keeps the legacy `server` callback for compatible OpenCode versions.

## Install and use in OpenCode

1. Add the plugin and API URL to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@dendaio/opencode-9router-plugin"],
  "provider": {
    "9router": {
      "api": "https://your-gateway.example/v1"
    }
  }
}
```

For Omniroute, use the same configuration and set `api` to your Omniroute OpenAI-compatible base URL. Keep the provider key as `9router` unless you create a plugin instance with a different `providerId`.

2. Login and set credentials:

```bash
opencode auth login
```

or inside OpenCode:

```
/connect 9router
```

3. Restart OpenCode, then verify:

```
/models
```

You should see models under provider `9router`.

## Why `provider` entry matters

OpenCode only calls `provider.models` for providers present in the `provider` section (singular key: `"provider"`). Ensure `provider.9router.api` is set before starting OpenCode.

## Configuration

Provider key must match the plugin provider id (default: `9router`). The existing configuration options for model enrichment, aliases, filtering, and static fallback models are supported under `provider.9router.options`.

## Environment variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Default key:

- `ROUTER9_API_KEY`

## Development

```bash
npm install
npm run typecheck
npm run build
```

Use the generated `dist/index.js` as a local plugin path in `opencode.json` and restart OpenCode after rebuilding.

## Troubleshooting

- **Plugin must export a default definition**: install the latest package version and rebuild the local plugin with `npm run build`.
- **401 Unauthorized**: check `ROUTER9_API_KEY` and the gateway authentication requirements.
- **404 Not Found**: check `provider.9router.api`; the plugin calls `{api}/models` if the URL ends with `/v1`, otherwise `{api}/v1/models`.
- **No discovered models**: verify that the gateway returns an OpenAI-compatible `{ "object": "list", "data": [...] }` response from `/v1/models`.

## License

MIT
