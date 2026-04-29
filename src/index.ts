import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Options for the models.dev enrichment sub-system. */
export interface ModelEnrichmentOptions {
  /** Set to `false` to disable models.dev enrichment entirely. Defaults to `true`. */
  enabled?: boolean;
  /** URL of the models.dev catalog JSON. Defaults to `"https://models.dev/api.json"`. */
  catalogURL?: string;
  /** HTTP timeout in ms for fetching the catalog. Defaults to `3000`. */
  timeoutMs?: number;
  /** How long (in ms) to cache the catalog in memory. Defaults to `10 * 60 * 1000`. */
  cacheTtlMs?: number;
  /** When `true`, models.dev values override upstream metadata. Defaults to `false`. */
  overrideUpstream?: boolean;
  /** Maps gateway provider prefixes to one or more models.dev provider keys (e.g. `{ gh: "github", ag: ["google-vertex", "google-vertex-anthropic"] }`). */
  providerAliases?: Record<string, string | string[]>;
  /** Fallback context window when upstream + models.dev do not provide limits. */
  defaultContextWindow?: number;
  /** Fallback max output tokens when upstream + models.dev do not provide limits. */
  defaultMaxOutputTokens?: number;
}

export interface ModelFilteringOptions {
  /** Only include models whose prefix (the part before the first `/`) is in this list.
   * Comparison is case-insensitive. When omitted or empty, all prefixes are allowed. */
  includePrefixes?: string[];
  /** Exclude models whose prefix (the part before the first `/`) is in this list.
   * Comparison is case-insensitive. Applied after include prefix filtering. */
  excludePrefixes?: string[];
  /** Allow-list upstream models by ID. Models must match this regex to be included. */
  includeModelIdRegex?: RegExp;
  /** Block-list upstream models by ID. Applied after include filters. */
  excludeModelIdRegex?: RegExp;
}

export interface RouterPluginOptions {
  providerId?: string;
  apiKeyEnvName?: string;
  /** models.dev enrichment configuration. */
  modelEnrichment?: ModelEnrichmentOptions;
  /** Model filtering configuration. */
  modelFiltering?: ModelFilteringOptions;
}

/** Model format expected by opencode (ModelV2). */
export interface OpenCodeModel {
  id: string;
  name: string;
  family: string;
  release_date: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean;
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface ProviderConfig {
  api?: string;
  key?: string;
  options?: Record<string, unknown>;
  models?: Record<string, OpenCodeModel>;
  [key: string]: unknown;
}

export interface AuthHook {
  provider: string;
  loader?: (
    getAuth: () => Promise<{ type?: string; key?: string }>,
    provider: ProviderConfig | undefined
  ) => Promise<Record<string, unknown>>;
  methods: Array<{
    type: "api";
    label: string;
    prompts?: Array<{
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
    }>;
    authorize?: (inputs?: Record<string, string>) => Promise<{
      type: "success";
      key?: string;
      provider?: string;
    } | {
      type: "failed";
    }>;
  }>;
}

export interface Hooks {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: (cfg: any) => Promise<void>;
  provider: {
    id: string;
    models: (
      provider: ProviderConfig,
      context?: { auth?: { type?: string; key?: string } }
    ) => Promise<Record<string, OpenCodeModel>>;
  };
  auth: AuthHook;
}

export interface PluginInput {
  [key: string]: unknown;
}

export interface PluginModule {
  id?: string;
  server: (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;
}

type UpstreamModel = {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    attachment?: boolean;
    reasoning?: boolean;
    temperature?: boolean;
    tool_call?: boolean;
    tool_calling?: boolean;
    supports_tools?: boolean;
    vision?: boolean;
    input?: {
      image?: boolean;
      pdf?: boolean;
    };
  };
  input_modalities?: string[];
  output_modalities?: string[];
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  tool_calling?: boolean;
  vision?: boolean;
};

type UpstreamModelList = {
  object: "list";
  data: UpstreamModel[];
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevCatalog = Record<string, ModelsDevProvider>;
type ModelsDevIndex = {
  exactByProvider: Map<string, Map<string, ModelsDevModel>>;
  normalizedByProvider: Map<string, Map<string, ModelsDevModel>>;
  exactGlobal: Map<string, ModelsDevModel[]>;
  normalizedGlobal: Map<string, ModelsDevModel[]>;
};

const DEFAULT_MODEL_ENRICHMENT: Required<Omit<ModelEnrichmentOptions, "providerAliases">> = {
  enabled: true,
  catalogURL: "https://models.dev/api.json",
  timeoutMs: 3000,
  cacheTtlMs: 10 * 60 * 1000,
  overrideUpstream: false,
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192
};

const DEFAULT_OPTIONS = {
  providerId: "9router",
  apiKeyEnvName: "ROUTER9_API_KEY"
};

type ModelsDevCache = {
  url: string;
  expiresAt: number;
  data: ModelsDevCatalog;
};

let modelsDevCache: ModelsDevCache | undefined;

const DEFAULT_MODELS_DEV_PROVIDER_ALIASES: Record<string, string | string[]> = {
  oai: "openai",
  openai: "openai",
  cx: "openai",
  codex: "openai",
  gh: "github",
  gl: "github",
  github: "github",
  anthropic: "anthropic",
  claude: "anthropic",
  gemini: "google",
  google: "google",
  deepseek: "deepseek",
  ds: "deepseek",
  mistral: "mistral",
  xai: "xai",
  groq: "groq",
  together: "together",
  openrouter: "openrouter",
  perplexity: "perplexity",
  pplx: "perplexity",
  cohere: "cohere"
};

function normalizeModelsURL(apiURL: string): string {
  let clean = apiURL;
  while (clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  return clean.endsWith("/v1") ? `${clean}/models` : `${clean}/v1/models`;
}

function isValidModelList(payload: unknown): payload is UpstreamModelList {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const maybe = payload as Partial<UpstreamModelList>;
  return (
    maybe.object === "list" &&
    Array.isArray(maybe.data) &&
    maybe.data.every((item) => item && typeof item.id === "string")
  );
}

function toDate(created?: number): string {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) {
    return "1970-01-01";
  }

  const iso = new Date(created * 1000).toISOString();
  return iso.slice(0, 10);
}

function inferFamily(modelId: string): string {
  const id = modelId.toLowerCase();

  if (id.includes("gpt-4o")) return "gpt-4o";
  if (id.includes("gpt-4.1")) return "gpt-4.1";
  if (id.includes("gpt-4")) return "gpt-4";
  if (id.includes("gpt-3.5")) return "gpt-3.5";
  if (id.includes("o1")) return "o1";
  if (id.includes("o3")) return "o3";

  const fallback = modelId.split(/[\-/:]/)[0]?.trim();
  return fallback || "unknown";
}

function toStrictlyPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function toRegex(value: unknown): RegExp | undefined {
  if (value instanceof RegExp) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const slashDelimited = trimmed.match(/^\/(.+)\/([a-zA-Z]*)$/);
  if (slashDelimited) {
    if (!/^[gimsuy]*$/.test(slashDelimited[2])) {
      return undefined;
    }
    try {
      return new RegExp(slashDelimited[1], slashDelimited[2]);
    } catch {
      return undefined;
    }
  }

  try {
    return new RegExp(trimmed);
  } catch {
    return undefined;
  }
}

function toProviderAliasRecord(value: unknown): Record<string, string[]> | undefined {
  if (!isObjectRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.trim()) {
      out[k.toLowerCase()] = [v.trim().toLowerCase()];
      continue;
    }
    if (Array.isArray(v)) {
      const aliases = v
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
      if (aliases.length > 0) {
        out[k.toLowerCase()] = Array.from(new Set(aliases));
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeProviderAliasRecords(
  ...records: Array<Record<string, string[]> | undefined>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [k, values] of Object.entries(record)) {
      const existing = out[k] ?? [];
      out[k] = Array.from(new Set([...existing, ...values]));
    }
  }
  return out;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function pickNumberWithOverride(
  upstream: number | undefined,
  enriched: number | undefined,
  fallback: number,
  override: boolean
): number {
  if (override) {
    return enriched ?? upstream ?? fallback;
  }
  return upstream ?? enriched ?? fallback;
}

function pickBooleanWithOverride(
  upstream: boolean | undefined,
  enriched: boolean | undefined,
  fallback: boolean,
  override: boolean
): boolean {
  if (override) {
    return enriched ?? upstream ?? fallback;
  }
  return upstream ?? enriched ?? fallback;
}

/**
 * Normalize model IDs for fuzzy matching:
 * - strips date suffixes (`-2024-11-20`)
 * - strips trailing version tags (`-v1`, `-4.5`)
 * - strips release labels (`-preview`, `-latest`, `-stable`)
 * - normalizes `_` to `-`
 */
function normalizeModelKey(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-v\d+$/, "")
    .replace(/-(preview|latest|stable)$/i, "")
    .replace(/-\d+\.\d+$/, "")
    .replace(/_/g, "-");
}

function splitModelForLookup(
  modelId: string,
  providerId: string
): { providerKey: string | null; modelKey: string } {
  const trimmed = modelId.trim();
  const gatewayPrefixes = new Set([
    providerId.toLowerCase(),
    "9router",
    "omniroute"
  ]);

  const slashParts = trimmed.split("/").filter((part) => part.trim() !== "");
  if (slashParts.length >= 3 && gatewayPrefixes.has(slashParts[0].toLowerCase())) {
    return {
      providerKey: slashParts[1],
      modelKey: slashParts.slice(2).join("/")
    };
  }
  if (slashParts.length >= 2) {
    return {
      providerKey: slashParts[0],
      modelKey: slashParts.slice(1).join("/")
    };
  }

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    return {
      providerKey: trimmed.slice(0, colonIdx),
      modelKey: trimmed.slice(colonIdx + 1)
    };
  }

  return { providerKey: null, modelKey: trimmed };
}

function resolveProviderAlias(
  providerKey: string | null,
  aliases?: Record<string, string[]>
): string[] {
  if (!providerKey) return [];
  const lower = providerKey.toLowerCase();
  const mapped = aliases?.[lower] ?? [lower];
  return mapped.includes(lower) ? mapped : [...mapped, lower];
}

function toOpenCodeModel(
  upstream: UpstreamModel,
  providerId: string,
  apiURL: string,
  contextWindow: number,
  maxOutputTokens: number,
  enriched?: ModelsDevModel,
  apiKey?: string,
  modelsDevOverrideUpstream: boolean = false
): OpenCodeModel {
  const { modelKey } = splitModelForLookup(upstream.id, providerId);
  const family =
    (typeof enriched?.family === "string" && enriched.family.trim() ? enriched.family : undefined) ||
    inferFamily(modelKey);
  const displayName = upstream.id;
  const releaseDate =
    typeof enriched?.release_date === "string" && enriched.release_date.trim()
      ? enriched.release_date
      : toDate(upstream.created);
  const upstreamContext = toStrictlyPositiveNumber(upstream.context_length);
  const upstreamOutput = toStrictlyPositiveNumber(upstream.max_output_tokens);
  const enrichedContext = toStrictlyPositiveNumber(enriched?.limit?.context);
  const enrichedOutput = toStrictlyPositiveNumber(enriched?.limit?.output);

  const context = pickNumberWithOverride(
    upstreamContext,
    enrichedContext,
    contextWindow,
    modelsDevOverrideUpstream
  );
  const output = pickNumberWithOverride(
    upstreamOutput,
    enrichedOutput,
    maxOutputTokens,
    modelsDevOverrideUpstream
  );

  const upstreamVision = firstBoolean(
    upstream.capabilities?.vision,
    upstream.vision,
    upstream.capabilities?.input?.image,
    Array.isArray(upstream.input_modalities) ? upstream.input_modalities.includes("image") : undefined
  );
  const upstreamAttachment = firstBoolean(
    upstream.capabilities?.attachment,
    upstream.attachment,
    Array.isArray(upstream.input_modalities)
      ? upstream.input_modalities.includes("image") || upstream.input_modalities.includes("pdf")
      : undefined
  );
  const upstreamReasoning = firstBoolean(upstream.capabilities?.reasoning, upstream.reasoning);
  const upstreamTemperature = firstBoolean(upstream.capabilities?.temperature, upstream.temperature);
  const upstreamToolcall = firstBoolean(
    upstream.capabilities?.tool_calling,
    upstream.capabilities?.tool_call,
    upstream.capabilities?.supports_tools,
    upstream.tool_calling,
    upstream.tool_call
  );

  const enrichedVision = firstBoolean(
    enriched?.modalities?.input?.includes("image"),
    enriched?.attachment
  );
  const enrichedAttachment = firstBoolean(
    enriched?.attachment,
    enriched?.modalities?.input?.includes("image")
  );
  const inferredFamily = inferFamily(modelKey);
  const inferredReasoning = inferredFamily === "o1" || inferredFamily === "o3";

  const attachment = pickBooleanWithOverride(
    upstreamAttachment,
    enrichedAttachment,
    false,
    modelsDevOverrideUpstream
  );
  const reasoning = pickBooleanWithOverride(
    upstreamReasoning,
    enriched?.reasoning,
    inferredReasoning,
    modelsDevOverrideUpstream
  );
  const temperature = pickBooleanWithOverride(
    upstreamTemperature,
    enriched?.temperature,
    true,
    modelsDevOverrideUpstream
  );
  const toolcall = pickBooleanWithOverride(
    upstreamToolcall,
    enriched?.tool_call,
    true,
    modelsDevOverrideUpstream
  );
  const supportsVision = pickBooleanWithOverride(
    upstreamVision,
    enrichedVision,
    attachment,
    modelsDevOverrideUpstream
  );

  return {
    id: upstream.id,
    name: displayName,
    family,
    release_date: releaseDate,
    api: {
      id: upstream.id,
      url: apiURL,
      npm: "@ai-sdk/openai-compatible"
    },
    capabilities: {
      temperature,
      reasoning,
      attachment,
      toolcall,
      input: {
        text: true,
        audio: false,
        image: supportsVision,
        video: false,
        pdf: attachment
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false
      },
      interleaved: reasoning
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0
      }
    },
    limit: {
      context,
      output
    },
    status: "active",
    options: {},
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  };
}

function regexPass(regex: RegExp | undefined, value: string): boolean {
  if (!regex) {
    return true;
  }

  regex.lastIndex = 0;
  return regex.test(value);
}

function prefixPass(includePrefixes: string[] | undefined, modelId: string, pluginProviderId: string): boolean {
  if (!includePrefixes || includePrefixes.length === 0) return true;
  const { providerKey } = splitModelForLookup(modelId, pluginProviderId);
  if (!providerKey) return false;
  const normalized = providerKey.toLowerCase();
  return includePrefixes.includes(normalized);
}

function prefixExcludePass(excludePrefixes: string[] | undefined, modelId: string, pluginProviderId: string): boolean {
  if (!excludePrefixes || excludePrefixes.length === 0) return true;
  const { providerKey } = splitModelForLookup(modelId, pluginProviderId);
  if (!providerKey) return true;
  const normalized = providerKey.toLowerCase();
  return !excludePrefixes.includes(normalized);
}

function normalizeApiURLInput(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function validateApiURL(value: string): string | undefined {
  const normalized = normalizeApiURLInput(value);
  if (!normalized) {
    return "API URL is required";
  }

  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "API URL must use http or https";
    }
  } catch {
    return "API URL is invalid";
  }

  return undefined;
}

/**
 * Resolve the opencode configuration directory using the same logic as
 * opencode itself:
 *  - Linux / other: $XDG_CONFIG_HOME/opencode  (falls back to ~/.config/opencode)
 *  - macOS:         ~/Library/Application Support/opencode
 *  - Windows:       %APPDATA%\opencode
 */
function openCodeConfigDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "opencode");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, "opencode");
    return path.join(home, "AppData", "Roaming", "opencode");
  }
  // Linux and everything else: honor XDG_CONFIG_HOME
  const xdg = process.env.XDG_CONFIG_HOME;
  const configBase = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
  return path.join(configBase, "opencode");
}

function openCodeConfigPath(): string {
  // Honor the same env var that opencode itself uses to override the config
  // file location (e.g. OPENCODE_CONFIG=/path/to/custom.json opencode …).
  const envOverride = process.env.OPENCODE_CONFIG;
  if (envOverride && path.isAbsolute(envOverride)) return envOverride;
  return path.join(openCodeConfigDir(), "opencode.json");
}

async function readProviderFromOpenCodeConfig(providerId: string): Promise<ProviderConfig | undefined> {
  const file = openCodeConfigPath();
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) return undefined;
    if (!isObjectRecord(parsed.provider)) return undefined;
    const provider = parsed.provider[providerId];
    if (!isObjectRecord(provider)) return undefined;
    return provider as ProviderConfig;
  } catch {
    return undefined;
  }
}

/**
 * Ensure the provider is listed under the `provider` key in opencode.json so
 * that opencode will invoke the plugin's `provider.models` hook on startup.
 *
 * Opencode only calls `provider.models` for providers that exist in its active
 * registry, which is built from the `provider` section of opencode.json
 * (note: the key is singular "provider", not "providers").
 * Without this entry the models hook is silently skipped regardless of whether
 * the user has valid credentials.
 *
 * Storing `api` and `key` in the provider entry also lets opencode's
 * /connect screen show the provider as properly configured.
 */
async function ensureProviderInOpenCodeConfig(
  providerId: string,
  patch: { api?: string; key?: string } = {}
): Promise<void> {
  const file = openCodeConfigPath();
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // file does not exist yet — start from scratch
  }

  const providerSection = config.provider;
  const providerObj: Record<string, unknown> =
    providerSection && typeof providerSection === "object" && !Array.isArray(providerSection)
      ? (providerSection as Record<string, unknown>)
      : {};

  const existing: Record<string, unknown> =
    isObjectRecord(providerObj[providerId]) ? (providerObj[providerId] as Record<string, unknown>) : {};

  const updated: Record<string, unknown> = { ...existing };
  let changed = false;

  if (patch.api && updated.api !== patch.api) {
    updated.api = patch.api;
    changed = true;
  }
  if (patch.key && updated.key !== patch.key) {
    updated.key = patch.key;
    changed = true;
  }

  if (isObjectRecord(updated.options) && "apiURL" in updated.options) {
    const cleanedOptions = { ...updated.options };
    delete cleanedOptions.apiURL;
    if (Object.keys(cleanedOptions).length > 0) {
      updated.options = cleanedOptions;
    } else {
      delete updated.options;
    }
    changed = true;
  }
  if ("apiURL" in updated) {
    delete updated.apiURL;
    changed = true;
  }

  // Skip the write if nothing has changed.
  if (typeof providerObj[providerId] !== "undefined" && !changed) {
    return;
  }

  providerObj[providerId] = updated;
  config.provider = providerObj;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stderr.write(
    `[opencode-9router-plugin] registered "${providerId}" in ${file} — restart opencode to load models\n`
  );
}

function pickApiKey(
  envApiKey: string | undefined,
  auth?: { type?: string; key?: string },
  providerKey?: string
): string {
  if (envApiKey) {
    return envApiKey;
  }
  // Accept the key regardless of the `type` field; opencode may store the auth
  // record with type "success" (from authorize return) or no type at all.
  if (typeof auth?.key === "string" && auth.key) {
    return auth.key;
  }
  if (typeof providerKey === "string" && providerKey) {
    return providerKey;
  }
  return "";
}

function pickApiURL(
  provider: ProviderConfig | undefined,
  configProvider: ProviderConfig | undefined
): string | undefined {
  if (provider && typeof provider.api === "string" && provider.api.trim()) {
    return normalizeApiURLInput(provider.api);
  }
  if (configProvider && typeof configProvider.api === "string" && configProvider.api.trim()) {
    return normalizeApiURLInput(configProvider.api);
  }
  return undefined;
}

async function fetchModels(
  apiURL: string,
  apiKey: string
): Promise<UpstreamModel[] | null> {
  const url = normalizeModelsURL(apiURL);
  const keyLabel = apiKey ? `${apiKey.slice(0, 8)}…` : "(none → using anonymous)";

  process.stderr.write(
    `[opencode-9router-plugin] fetchModels → GET ${url}  key=${keyLabel}\n`
  );

  const headers: Record<string, string> = {
    // Always send an Authorization header. The gateway is public and accepts
    // any non-empty key, but omitting the header entirely may cause a 401.
    Authorization: `Bearer ${apiKey || "anonymous"}`
  };

  try {
    const response = await fetch(url, {
      method: "GET",
      headers
    });

    process.stderr.write(
      `[opencode-9router-plugin] fetchModels ← ${response.status} ${response.statusText}\n`
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      process.stderr.write(
        `[opencode-9router-plugin] fetchModels error body: ${body.slice(0, 300)}\n`
      );
      return null;
    }

    const payload = (await response.json()) as unknown;
    if (!isValidModelList(payload)) {
      process.stderr.write(
        `[opencode-9router-plugin] fetchModels invalid /models schema: ${JSON.stringify(payload).slice(0, 300)}\n`
      );
      return null;
    }

    process.stderr.write(
      `[opencode-9router-plugin] fetchModels success: ${payload.data.length} models\n`
    );
    return payload.data;
  } catch (err) {
    process.stderr.write(
      `[opencode-9router-plugin] fetchModels request error: ${String(err)}\n`
    );
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelsDevCatalog(payload: unknown): payload is ModelsDevCatalog {
  if (!isObjectRecord(payload)) {
    return false;
  }
  return Object.values(payload).every((provider) => {
    if (!isObjectRecord(provider)) {
      return false;
    }
    if (provider.models === undefined) {
      return true;
    }
    if (!isObjectRecord(provider.models)) {
      return false;
    }
    return Object.values(provider.models).every((model) => isObjectRecord(model));
  });
}

async function fetchModelsDevCatalog(
  catalogURL: string,
  timeoutMs: number,
  cacheTtlMs: number
): Promise<ModelsDevCatalog | null> {
  const now = Date.now();
  if (
    modelsDevCache &&
    modelsDevCache.url === catalogURL &&
    modelsDevCache.expiresAt > now
  ) {
    return modelsDevCache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(catalogURL, {
      method: "GET",
      signal: controller.signal
    });
    if (!response.ok) {
      console.warn(
        `[opencode-9router-plugin] models.dev enrichment unavailable (${response.status} ${response.statusText})`
      );
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!isModelsDevCatalog(payload)) {
      console.warn("[opencode-9router-plugin] models.dev enrichment unavailable (invalid schema)");
      return null;
    }

    modelsDevCache = {
      url: catalogURL,
      expiresAt: now + cacheTtlMs,
      data: payload
    };
    return payload;
  } catch {
    console.warn("[opencode-9router-plugin] models.dev enrichment unavailable (request error)");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildModelsDevIndex(catalog: ModelsDevCatalog): ModelsDevIndex {
  const exactByProvider = new Map<string, Map<string, ModelsDevModel>>();
  const normalizedByProvider = new Map<string, Map<string, ModelsDevModel>>();
  const exactGlobal = new Map<string, ModelsDevModel[]>();
  const normalizedGlobal = new Map<string, ModelsDevModel[]>();

  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider.models) continue;

    const providerExact = new Map<string, ModelsDevModel>();
    const providerNormalized = new Map<string, ModelsDevModel>();

    for (const [modelId, model] of Object.entries(provider.models)) {
      const exactKey = modelId.toLowerCase();
      const normalizedKey = normalizeModelKey(modelId);

      providerExact.set(exactKey, model);
      providerNormalized.set(normalizedKey, model);

      const globalExact = exactGlobal.get(exactKey) ?? [];
      globalExact.push(model);
      exactGlobal.set(exactKey, globalExact);

      const globalNormalized = normalizedGlobal.get(normalizedKey) ?? [];
      globalNormalized.push(model);
      normalizedGlobal.set(normalizedKey, globalNormalized);
    }

    exactByProvider.set(providerId.toLowerCase(), providerExact);
    normalizedByProvider.set(providerId.toLowerCase(), providerNormalized);
  }

  return {
    exactByProvider,
    normalizedByProvider,
    exactGlobal,
    normalizedGlobal
  };
}

function singleOrUndefined<T>(values: T[] | undefined): T | undefined {
  return values?.length === 1 ? values[0] : undefined;
}

function findEnrichedModel(
  modelId: string,
  providerId: string,
  index: ModelsDevIndex | undefined,
  providerAliases: Record<string, string[]>
): ModelsDevModel | undefined {
  if (!index) return undefined;

  const { providerKey, modelKey } = splitModelForLookup(modelId, providerId);
  const aliases = resolveProviderAlias(providerKey, providerAliases);
  const exactKey = modelKey.toLowerCase();
  const normalizedKey = normalizeModelKey(modelKey);

  for (const alias of aliases) {
    const providerExact = index.exactByProvider.get(alias)?.get(exactKey);
    if (providerExact) return providerExact;
    const providerNormalized = index.normalizedByProvider.get(alias)?.get(normalizedKey);
    if (providerNormalized) return providerNormalized;
  }

  const globalExact = singleOrUndefined(index.exactGlobal.get(exactKey));
  const globalNormalized = singleOrUndefined(index.normalizedGlobal.get(normalizedKey));

  return globalExact ?? globalNormalized;
}

export function createOpenAICompatibleModelsPlugin(options: RouterPluginOptions = {}) {
  const { providerId, apiKeyEnvName } = {
    ...DEFAULT_OPTIONS,
    ...options
  };
  const configuredEnrichmentOpts = { ...DEFAULT_MODEL_ENRICHMENT, ...(options.modelEnrichment ?? {}) };
  const configuredFilteringOpts = options.modelFiltering ?? {};
  const configuredProviderAliases = mergeProviderAliasRecords(
    toProviderAliasRecord(DEFAULT_MODELS_DEV_PROVIDER_ALIASES),
    toProviderAliasRecord(options.modelEnrichment?.providerAliases)
  );

  return async (_input: PluginInput): Promise<Hooks> => {
    return {
      provider: {
        id: providerId,
        models: async (
          provider: ProviderConfig,
          context?: { auth?: { type?: string; key?: string } }
        ): Promise<Record<string, OpenCodeModel>> => {
          const configProvider = await readProviderFromOpenCodeConfig(providerId);
          const providerOptions = isObjectRecord(provider.options) ? provider.options : undefined;
          const providerEnrichment = isObjectRecord(providerOptions?.modelEnrichment)
            ? providerOptions.modelEnrichment
            : undefined;
          const providerFiltering = isObjectRecord(providerOptions?.modelFiltering)
            ? providerOptions.modelFiltering
            : undefined;
          const timeoutMs = toStrictlyPositiveNumber(providerEnrichment?.timeoutMs);
          const cacheTtlMs = toStrictlyPositiveNumber(providerEnrichment?.cacheTtlMs);
          const defaultContextWindow = toStrictlyPositiveNumber(providerEnrichment?.defaultContextWindow);
          const defaultMaxOutputTokens = toStrictlyPositiveNumber(providerEnrichment?.defaultMaxOutputTokens);

          const runtimeEnrichmentOpts = {
            ...configuredEnrichmentOpts,
            ...(typeof providerEnrichment?.enabled === "boolean" ? { enabled: providerEnrichment.enabled } : {}),
            ...(typeof providerEnrichment?.catalogURL === "string" && providerEnrichment.catalogURL.trim()
              ? { catalogURL: providerEnrichment.catalogURL }
              : {}),
            ...(timeoutMs !== undefined
              ? { timeoutMs }
              : {}),
            ...(cacheTtlMs !== undefined
              ? { cacheTtlMs }
              : {}),
            ...(typeof providerEnrichment?.overrideUpstream === "boolean"
              ? { overrideUpstream: providerEnrichment.overrideUpstream }
              : {}),
            ...(defaultContextWindow !== undefined
              ? { defaultContextWindow }
              : {}),
            ...(defaultMaxOutputTokens !== undefined
              ? { defaultMaxOutputTokens }
              : {})
          };
          const runtimeProviderAliases = mergeProviderAliasRecords(
            configuredProviderAliases,
            toProviderAliasRecord(providerEnrichment?.providerAliases)
          );
          const runtimeFilteringOpts = {
            includePrefixes: toStringArray(providerFiltering?.includePrefixes) ?? configuredFilteringOpts.includePrefixes,
            excludePrefixes: toStringArray(providerFiltering?.excludePrefixes) ?? configuredFilteringOpts.excludePrefixes,
            includeModelIdRegex: toRegex(providerFiltering?.includeModelIdRegex) ?? configuredFilteringOpts.includeModelIdRegex,
            excludeModelIdRegex: toRegex(providerFiltering?.excludeModelIdRegex) ?? configuredFilteringOpts.excludeModelIdRegex
          };
          const normalizedIncludePrefixes = runtimeFilteringOpts.includePrefixes?.map((p) => p.toLowerCase());
          const normalizedExcludePrefixes = runtimeFilteringOpts.excludePrefixes?.map((p) => p.toLowerCase());
          const enrichmentEnabled = runtimeEnrichmentOpts.enabled !== false;

          const staticModels = provider.models ?? {};
          // Probe several places where opencode may surface the API key:
          //  1. env var
          //  2. context.auth.key (from auth.json, regardless of type field)
          //  3. provider.key (direct config)
          //  4. provider.options?.apiKey (loader return value landing spot)
          const optionsApiKey =
            isObjectRecord(provider.options) && typeof provider.options.apiKey === "string"
              ? provider.options.apiKey
              : undefined;
          const apiKey =
            pickApiKey(process.env[apiKeyEnvName], context?.auth, provider.key) || optionsApiKey || "";
          const apiURL = pickApiURL(provider, configProvider);
          if (!apiURL || validateApiURL(apiURL)) {
            process.stderr.write(
              `[opencode-9router-plugin] models hook: no API URL configured, returning ${Object.keys(staticModels).length} static model(s)\n`
            );
            return staticModels;
          }
          const modelsDevCatalog = enrichmentEnabled
            ? await fetchModelsDevCatalog(
              runtimeEnrichmentOpts.catalogURL,
              runtimeEnrichmentOpts.timeoutMs,
              runtimeEnrichmentOpts.cacheTtlMs
            )
            : undefined;
          const modelsDevIndex = modelsDevCatalog ? buildModelsDevIndex(modelsDevCatalog) : undefined;

          const upstreamModels = await fetchModels(apiURL, apiKey);
          if (!upstreamModels) {
            process.stderr.write(
              `[opencode-9router-plugin] models hook: fetch failed, returning ${Object.keys(staticModels).length} static model(s)\n`
            );
            return staticModels;
          }

          process.stderr.write(
            `[opencode-9router-plugin] models hook: building ${upstreamModels.length} dynamic model(s)\n`
          );

          const dynamicModels = upstreamModels
            .filter((model) => {
              const { modelKey } = splitModelForLookup(model.id, providerId);
              const includePass = regexPass(runtimeFilteringOpts.includeModelIdRegex, model.id)
                || regexPass(runtimeFilteringOpts.includeModelIdRegex, modelKey);
              const excludePass = !runtimeFilteringOpts.excludeModelIdRegex
                || (!regexPass(runtimeFilteringOpts.excludeModelIdRegex, model.id)
                  && !regexPass(runtimeFilteringOpts.excludeModelIdRegex, modelKey));
              return includePass
                && excludePass
                && prefixPass(normalizedIncludePrefixes, model.id, providerId)
                && prefixExcludePass(normalizedExcludePrefixes, model.id, providerId);
            })
            .reduce<Record<string, OpenCodeModel>>((acc, model) => {
              const enriched = findEnrichedModel(model.id, providerId, modelsDevIndex, runtimeProviderAliases);
              acc[model.id] = toOpenCodeModel(
                model,
                providerId,
                apiURL,
                runtimeEnrichmentOpts.defaultContextWindow,
                runtimeEnrichmentOpts.defaultMaxOutputTokens,
                enriched,
                apiKey,
                runtimeEnrichmentOpts.overrideUpstream
              );
              return acc;
            }, {});

          const result = {
            ...staticModels,
            ...dynamicModels
          };
          process.stderr.write(
            `[opencode-9router-plugin] models hook: returning ${Object.keys(result).length} total model(s)\n`
          );
          return result;
        }
      },
      auth: {
        provider: providerId,
        loader: async (getAuth, provider) => {
          const auth = await getAuth().catch(() => undefined);
          const configProvider = await readProviderFromOpenCodeConfig(providerId);
          return {
            apiKey: pickApiKey(process.env[apiKeyEnvName], auth, (provider as ProviderConfig | undefined)?.key),
            api: pickApiURL(provider as ProviderConfig | undefined, configProvider)
          };
        },
        methods: [
          {
            type: "api",
            label: "Login with 9Router API key",
            authorize: async (inputs = {}) => {
              // Ignore non-key auth payload fields intentionally.
              // API URL is sourced from provider.<id>.api in opencode.json.
              const apiKey = typeof inputs.key === "string" && inputs.key ? inputs.key : undefined;
              // Ensure opencode.json has this provider listed so opencode will
              // call the provider.models hook. Without this entry opencode never
              // invokes the hook and no models are discovered.
              // When auth succeeds, persist only key into opencode.json.
              await ensureProviderInOpenCodeConfig(providerId, { ...(apiKey ? { key: apiKey } : {}) });
              return apiKey !== undefined ? { type: "success", key: apiKey } : { type: "success" };
            }
          }
        ]
      }
    };
  };
}

const plugin = createOpenAICompatibleModelsPlugin();

export default { id: "9router", server: plugin } satisfies PluginModule;
