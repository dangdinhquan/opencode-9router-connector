import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RouterPluginOptions {
  providerId?: string;
  defaultBaseURL?: string;
  apiKeyEnvName?: string;
  defaultContextWindow?: number;
  defaultMaxOutputTokens?: number;
  modelsDevCatalogURL?: string;
  modelsDevTimeoutMs?: number;
  modelsDevCacheTtlMs?: number;
  includeModelIdRegex?: RegExp;
  excludeModelIdRegex?: RegExp;
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
  baseURL?: string;
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
  created?: number;
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
  limit?: {
    context?: number;
    output?: number;
  };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const DEFAULT_OPTIONS: Required<
  Omit<RouterPluginOptions, "includeModelIdRegex" | "excludeModelIdRegex">
> = {
  providerId: "9router",
  defaultBaseURL: "https://api.your_9router.com/v1",
  apiKeyEnvName: "ROUTER9_API_KEY",
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192,
  modelsDevCatalogURL: "https://models.dev/api.json",
  modelsDevTimeoutMs: 3000,
  modelsDevCacheTtlMs: 10 * 60 * 1000
};

type PluginSettings = {
  baseURL?: string;
  apiKey?: string;
};

type ModelsDevCache = {
  url: string;
  expiresAt: number;
  data: ModelsDevCatalog;
};

let modelsDevCache: ModelsDevCache | undefined;

// Provider alias → display name mapping.
// Aliases are sourced from 9router's provider definitions:
// https://github.com/decolua/9router/blob/main/src/shared/constants/providers.js
const PROVIDER_ALIAS_TO_NAME: Record<string, string> = {
  "9router": "9Router",

  // Free Providers
  kr: "Kiro AI",
  kiro: "Kiro AI",
  qw: "Qwen Code",
  qwen: "Qwen Code",
  gc: "Gemini CLI",
  "gemini-cli": "Gemini CLI",
  if: "iFlow AI",
  iflow: "iFlow AI",
  iflowcn: "iFlow AI",
  oc: "OpenCode Free",
  opencode: "OpenCode Free",

  // OAuth Providers
  cc: "Claude Code",
  claude: "Claude Code",
  ag: "Antigravity",
  antigravity: "Antigravity",
  cx: "OpenAI Codex",
  codex: "OpenAI Codex",
  gh: "GitHub Copilot",
  github: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  cu: "Cursor IDE",
  cursor: "Cursor IDE",
  kc: "Kilo Code",
  kilocode: "Kilo Code",
  cl: "Cline",
  cline: "Cline",

  // Free Tier Providers
  openrouter: "OpenRouter",
  nvidia: "NVIDIA NIM",
  ollama: "Ollama Cloud",
  vx: "Vertex AI",
  vertex: "Vertex AI",
  gemini: "Gemini",
  google: "Google",
  bpm: "BytePlus ModelArk",
  byteplus: "BytePlus ModelArk",

  // API Key Providers
  openai: "OpenAI",
  anthropic: "Anthropic",
  ocg: "OpenCode Go",
  "opencode-go": "OpenCode Go",
  azure: "Azure OpenAI",
  ds: "DeepSeek",
  deepseek: "DeepSeek",
  groq: "Groq",
  xai: "xAI (Grok)",
  mistral: "Mistral",
  pplx: "Perplexity",
  perplexity: "Perplexity",
  together: "Together AI",
  fireworks: "Fireworks AI",
  cerebras: "Cerebras",
  cohere: "Cohere",
  nebius: "Nebius AI",
  siliconflow: "SiliconFlow",
  hyp: "Hyperbolic",
  hyperbolic: "Hyperbolic",
  glm: "GLM Coding",
  "glm-cn": "GLM (China)",
  kimi: "Kimi",
  minimax: "Minimax Coding",
  "minimax-cn": "Minimax (China)",
  alicode: "Alibaba",
  "alicode-intl": "Alibaba Intl",
  ark: "Volcengine Ark",
  "volcengine-ark": "Volcengine Ark",
  hf: "HuggingFace",
  huggingface: "HuggingFace",
  bb: "Blackbox AI",
  blackbox: "Blackbox AI",
  ch: "Chutes AI",
  chutes: "Chutes AI",
  "ollama-local": "Ollama Local",
  vxp: "Vertex Partner",
  "vertex-partner": "Vertex Partner",
  dg: "Deepgram",
  deepgram: "Deepgram",
  aai: "AssemblyAI",
  assemblyai: "AssemblyAI",
  nb: "NanoBanana",
  nanobanana: "NanoBanana",
  el: "ElevenLabs",
  elevenlabs: "ElevenLabs",

  // Web Cookie Providers
  gw: "Grok Web",
  "grok-web": "Grok Web",
  pw: "Perplexity Web",
  "perplexity-web": "Perplexity Web",

  // Legacy / fallback aliases
  op: "OpenCode",
  gl: "GitHub Copilot"
};

function normalizeModelsURL(baseURL: string): string {
  let clean = baseURL;
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

/**
 * Split a 9Router model ID into [providerAlias, modelPart].
 * 9Router uses `{alias}/{model}` or `{alias}:{model}` conventions.
 * Returns [undefined, fullId] when no provider prefix is detected.
 */
function splitProviderAlias(modelId: string): [string | undefined, string] {
  const slashIdx = modelId.indexOf("/");
  const colonIdx = modelId.indexOf(":");
  const sep = slashIdx !== -1 && (colonIdx === -1 || slashIdx < colonIdx) ? slashIdx : colonIdx;
  if (sep > 0) {
    return [modelId.slice(0, sep), modelId.slice(sep + 1)];
  }
  return [undefined, modelId];
}

/**
 * Map a provider alias to its display name using the known alias table.
 * Lowercase-normalizes the alias before lookup.
 */
function providerDisplayName(alias: string): string {
  return PROVIDER_ALIAS_TO_NAME[alias.toLowerCase()] ?? alias;
}

function toOpenCodeModel(
  upstream: UpstreamModel,
  _providerId: string,
  baseURL: string,
  contextWindow: number,
  maxOutputTokens: number,
  enriched?: ModelsDevModel,
  apiKey?: string
): OpenCodeModel {
  const [providerAlias, modelPart] = splitProviderAlias(upstream.id);
  const providerGroup = providerAlias
    ? `9Router - ${providerDisplayName(providerAlias)}`
    : "9Router";

  const family = providerGroup;
  const displayName =
    typeof enriched?.name === "string" && enriched.name.trim()
      ? enriched.name
      : modelPart;
  const releaseDate =
    typeof enriched?.release_date === "string" && enriched.release_date.trim()
      ? enriched.release_date
      : toDate(upstream.created);
  const enrichedContext = enriched?.limit?.context;
  const enrichedOutput = enriched?.limit?.output;
  const context =
    typeof enrichedContext === "number" && Number.isFinite(enrichedContext) && enrichedContext > 0
      ? enrichedContext
      : contextWindow;
  const output =
    typeof enrichedOutput === "number" && Number.isFinite(enrichedOutput) && enrichedOutput > 0
      ? enrichedOutput
      : maxOutputTokens;

  const attachment = typeof enriched?.attachment === "boolean" ? enriched.attachment : false;
  const inferredFamily = inferFamily(modelPart);
  const reasoning =
    typeof enriched?.reasoning === "boolean"
      ? enriched.reasoning
      : inferredFamily === "o1" || inferredFamily === "o3";
  const temperature = typeof enriched?.temperature === "boolean" ? enriched.temperature : true;
  const toolcall = typeof enriched?.tool_call === "boolean" ? enriched.tool_call : true;

  return {
    id: upstream.id,
    name: displayName,
    family,
    release_date: releaseDate,
    api: {
      id: upstream.id,
      url: baseURL,
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
        image: attachment,
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

function normalizeBaseURLInput(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function validateBaseURL(value: string): string | undefined {
  const normalized = normalizeBaseURLInput(value);
  if (!normalized) {
    return "Base URL is required";
  }

  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Base URL must use http or https";
    }
  } catch {
    return "Base URL is invalid";
  }

  return undefined;
}

function settingsFilePath(providerId: string): string {
  return path.join(os.homedir(), ".config", "opencode", `opencode-9router-plugin.${providerId}.json`);
}

function openCodeConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
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
 */
async function ensureProviderInOpenCodeConfig(providerId: string): Promise<void> {
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

  if (typeof providerObj[providerId] !== "undefined") {
    // already registered — nothing to do
    return;
  }

  providerObj[providerId] = {};
  config.provider = providerObj;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  process.stderr.write(
    `[opencode-9router-plugin] registered "${providerId}" in ${file} — restart opencode to load models\n`
  );
}

async function readSettings(providerId: string): Promise<PluginSettings> {
  const file = settingsFilePath(providerId);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as PluginSettings;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

async function writeSettings(providerId: string, patch: PluginSettings): Promise<void> {
  const file = settingsFilePath(providerId);
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readSettings(providerId);
  const next = {
    ...current,
    ...patch
  };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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

function pickBaseURL(
  provider: ProviderConfig | undefined,
  defaultBaseURL: string,
  persistedBaseURL?: string
): string {
  if (provider) {
    // New ProviderV2 format: baseURL/api stored under provider.options
    if (isObjectRecord(provider.options)) {
      const optApi =
        typeof provider.options.api === "string" && provider.options.api.trim()
          ? normalizeBaseURLInput(provider.options.api)
          : undefined;
      if (optApi) return optApi;

      const optBaseURL =
        typeof provider.options.baseURL === "string" && provider.options.baseURL.trim()
          ? normalizeBaseURLInput(provider.options.baseURL)
          : undefined;
      if (optBaseURL) return optBaseURL;
    }

    // Legacy direct fields
    const api =
      typeof provider.api === "string" && provider.api.trim()
        ? normalizeBaseURLInput(provider.api)
        : undefined;
    if (api) return api;

    const baseURL =
      typeof provider.baseURL === "string" && provider.baseURL.trim()
        ? normalizeBaseURLInput(provider.baseURL)
        : undefined;
    if (baseURL) return baseURL;
  }

  if (persistedBaseURL && !validateBaseURL(persistedBaseURL)) {
    return normalizeBaseURLInput(persistedBaseURL);
  }

  return normalizeBaseURLInput(defaultBaseURL);
}

async function fetchModels(
  baseURL: string,
  apiKey: string
): Promise<UpstreamModel[] | null> {
  const url = normalizeModelsURL(baseURL);
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

function canonicalVariant(id: string): string {
  return id.trim().toLowerCase();
}

function modelIdVariants(id: string): string[] {
  const normalized = canonicalVariant(id);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);
  if (normalized.includes("/")) {
    const slashParts = normalized.split("/");
    if (slashParts.length >= 2) {
      variants.add(slashParts.slice(1).join("/"));
      variants.add(`${slashParts[0]}:${slashParts.slice(1).join("/")}`);
    }
  }
  if (normalized.includes(":")) {
    const colonParts = normalized.split(":");
    if (colonParts.length >= 2) {
      variants.add(colonParts.slice(1).join(":"));
      variants.add(`${colonParts[0]}/${colonParts.slice(1).join(":")}`);
    }
  }
  return [...variants];
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

function buildModelsDevLookup(catalog: ModelsDevCatalog): Map<string, ModelsDevModel> {
  const lookup = new Map<string, ModelsDevModel>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider.models) {
      continue;
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      for (const variant of modelIdVariants(`${providerId}/${modelId}`)) {
        if (!lookup.has(variant)) {
          lookup.set(variant, model);
        }
      }
      for (const variant of modelIdVariants(modelId)) {
        if (!lookup.has(variant)) {
          lookup.set(variant, model);
        }
      }
      if (typeof model.id === "string") {
        for (const variant of modelIdVariants(model.id)) {
          if (!lookup.has(variant)) {
            lookup.set(variant, model);
          }
        }
      }
    }
  }
  return lookup;
}

function findEnrichedModel(
  modelId: string,
  lookup?: Map<string, ModelsDevModel>
): ModelsDevModel | undefined {
  if (!lookup) {
    return undefined;
  }
  for (const variant of modelIdVariants(modelId)) {
    const match = lookup.get(variant);
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * Build a model entry suitable for injection into an opencode config provider.
 * The returned object matches the shape that opencode's config parser reads.
 */
function buildConfigModelEntry(
  upstream: UpstreamModel,
  modelPart: string,
  baseURL: string,
  contextWindow: number,
  maxOutputTokens: number,
  enriched?: ModelsDevModel,
  apiKey?: string
): Record<string, unknown> {
  const attachment = typeof enriched?.attachment === "boolean" ? enriched.attachment : false;
  const inferredFamily = inferFamily(modelPart);
  const reasoning =
    typeof enriched?.reasoning === "boolean"
      ? enriched.reasoning
      : inferredFamily === "o1" || inferredFamily === "o3";
  const temperature = typeof enriched?.temperature === "boolean" ? enriched.temperature : true;
  const toolCall = typeof enriched?.tool_call === "boolean" ? enriched.tool_call : true;
  const context =
    typeof enriched?.limit?.context === "number" && enriched.limit.context > 0
      ? enriched.limit.context
      : contextWindow;
  const output =
    typeof enriched?.limit?.output === "number" && enriched.limit.output > 0
      ? enriched.limit.output
      : maxOutputTokens;
  const releaseDate =
    typeof enriched?.release_date === "string" && enriched.release_date.trim()
      ? enriched.release_date
      : toDate(upstream.created);
  const displayName =
    typeof enriched?.name === "string" && enriched.name.trim() ? enriched.name : modelPart;

  const inputModalities = ["text", ...(attachment ? ["image", "pdf"] : [])];

  return {
    id: upstream.id,
    name: displayName,
    temperature,
    reasoning,
    attachment,
    tool_call: toolCall,
    modalities: { input: inputModalities, output: ["text"] },
    limit: { context, output },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    provider: { npm: "@ai-sdk/openai-compatible", api: baseURL },
    status: "active",
    release_date: releaseDate,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  };
}

export function createOpenAICompatibleModelsPlugin(options: RouterPluginOptions = {}) {
  const {
    providerId,
    defaultBaseURL,
    apiKeyEnvName,
    defaultContextWindow,
    defaultMaxOutputTokens,
    modelsDevCatalogURL,
    modelsDevTimeoutMs,
    modelsDevCacheTtlMs,
    includeModelIdRegex,
    excludeModelIdRegex
  } = {
    ...DEFAULT_OPTIONS,
    ...options
  };

  return async (_input: PluginInput): Promise<Hooks> => {
    // Tracks whether the config hook successfully injected sub-providers.
    // Used by the provider.models hook to decide whether to return a flat list
    // (fallback) or only standalone models (sub-providers active).
    let subProvidersInjected = false;

    return {
      // ------------------------------------------------------------------ //
      // config hook — runs early, before provider models are loaded.         //
      // Injects one virtual provider per 9Router sub-provider alias so      //
      // OpenCode shows separate groups (e.g., "9Router - Antigravity").     //
      // ------------------------------------------------------------------ //
      config: async (cfg: Record<string, unknown>): Promise<void> => {
        try {
          // Resolve the API key: env var takes priority, then persisted settings
          // (written by a previous provider.models run via opencode auth).
          const settings = await readSettings(providerId);
          const apiKey =
            process.env[apiKeyEnvName] ||
            (isObjectRecord(cfg?.provider) &&
            isObjectRecord((cfg.provider as Record<string, unknown>)[providerId]) &&
            typeof ((cfg.provider as Record<string, unknown>)[providerId] as Record<string, unknown>).key === "string"
              ? ((cfg.provider as Record<string, unknown>)[providerId] as Record<string, unknown>).key as string
              : "") ||
            settings.apiKey ||
            "";

          if (!apiKey) {
            process.stderr.write(
              `[opencode-9router-plugin] config hook: no API key available, skipping sub-provider injection\n`
            );
            return;
          }

          // Resolve the base URL
          const cfgProviderEntry =
            isObjectRecord(cfg?.provider) &&
            isObjectRecord((cfg.provider as Record<string, unknown>)[providerId])
              ? ((cfg.provider as Record<string, unknown>)[providerId] as Record<string, unknown>)
              : undefined;
          const baseURL =
            (typeof cfgProviderEntry?.api === "string" && cfgProviderEntry.api.trim()
              ? normalizeBaseURLInput(cfgProviderEntry.api)
              : undefined) ||
            (typeof cfgProviderEntry?.baseURL === "string" && cfgProviderEntry.baseURL.trim()
              ? normalizeBaseURLInput(cfgProviderEntry.baseURL)
              : undefined) ||
            settings.baseURL ||
            defaultBaseURL;

          // Fetch available models
          const upstreamModels = await fetchModels(baseURL, apiKey);
          if (!upstreamModels) {
            process.stderr.write(
              `[opencode-9router-plugin] config hook: model fetch failed, skipping sub-provider injection\n`
            );
            return;
          }

          // Apply include/exclude filters
          const filtered = upstreamModels
            .filter((m) => regexPass(includeModelIdRegex, m.id))
            .filter((m) => !excludeModelIdRegex || !regexPass(excludeModelIdRegex, m.id));

          if (filtered.length === 0) {
            process.stderr.write(
              `[opencode-9router-plugin] config hook: no models after filtering, skipping\n`
            );
            return;
          }

          // Enrich from models.dev
          const catalog = await fetchModelsDevCatalog(
            modelsDevCatalogURL,
            modelsDevTimeoutMs,
            modelsDevCacheTtlMs
          );
          const lookup = catalog ? buildModelsDevLookup(catalog) : undefined;

          // Group models by sub-provider alias
          const groups = new Map<string, UpstreamModel[]>();
          for (const model of filtered) {
            const [alias] = splitProviderAlias(model.id);
            const group = alias ?? "_standalone";
            const arr = groups.get(group) ?? [];
            arr.push(model);
            groups.set(group, arr);
          }

          // Inject one virtual provider per sub-provider alias into the config.
          // OpenCode reads cfg.provider after all config() hooks run, so these
          // entries will appear as regular config providers in the model picker.
          if (!isObjectRecord(cfg.provider)) {
            cfg.provider = {};
          }
          const cfgProvider = cfg.provider as Record<string, unknown>;

          let injectedCount = 0;
          for (const [alias, models] of groups) {
            if (alias === "_standalone") {
              // Standalone models (no prefix) are handled by the provider.models hook
              continue;
            }
            const subId = `${providerId}-${alias}`;
            const subName = `9Router - ${providerDisplayName(alias)}`;

            const modelConfigs: Record<string, unknown> = {};
            for (const model of models) {
              const [, modelPart] = splitProviderAlias(model.id);
              const enriched = findEnrichedModel(model.id, lookup);
              modelConfigs[model.id] = buildConfigModelEntry(
                model,
                modelPart,
                baseURL,
                defaultContextWindow,
                defaultMaxOutputTokens,
                enriched,
                apiKey
              );
            }

            cfgProvider[subId] = {
              name: subName,
              env: [apiKeyEnvName],
              key: apiKey,
              models: modelConfigs,
            };
            injectedCount++;
          }

          subProvidersInjected = injectedCount > 0;
          process.stderr.write(
            `[opencode-9router-plugin] config hook: injected ${injectedCount} sub-provider(s) ` +
              `(${filtered.length} total model(s))\n`
          );
        } catch (err) {
          process.stderr.write(
            `[opencode-9router-plugin] config hook error (will fall back to flat list): ${String(err)}\n`
          );
        }
      },

      provider: {
        id: providerId,
        models: async (
          provider: ProviderConfig,
          context?: { auth?: { type?: string; key?: string } }
        ): Promise<Record<string, OpenCodeModel>> => {
          const staticModels = provider.models ?? {};
          const settings = await readSettings(providerId);
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

          // Persist the resolved API key so the config hook can use it on the
          // next startup when the key comes from opencode's auth system (not env var).
          if (apiKey && apiKey !== settings.apiKey) {
            await writeSettings(providerId, { ...settings, apiKey }).catch(() => undefined);
          }

          const baseURL = pickBaseURL(provider, defaultBaseURL, settings.baseURL);

          // When sub-providers have been injected by the config hook each named
          // sub-provider manages its own model group.  The provider.models hook
          // only needs to return models that have NO alias prefix (standalone).
          // If there are none, returning {} causes this provider group to be
          // hidden automatically by opencode (empty providers are pruned).
          if (subProvidersInjected) {
            const upstreamModels = await fetchModels(baseURL, apiKey);
            const modelsDevCatalog = await fetchModelsDevCatalog(
              modelsDevCatalogURL,
              modelsDevTimeoutMs,
              modelsDevCacheTtlMs
            );
            const modelsDevLookup = modelsDevCatalog ? buildModelsDevLookup(modelsDevCatalog) : undefined;

            const standaloneModels: Record<string, OpenCodeModel> = {};
            if (upstreamModels) {
              for (const model of upstreamModels) {
                const [alias] = splitProviderAlias(model.id);
                if (alias) continue; // handled by sub-provider
                if (!regexPass(includeModelIdRegex, model.id)) continue;
                if (excludeModelIdRegex && regexPass(excludeModelIdRegex, model.id)) continue;
                const enriched = findEnrichedModel(model.id, modelsDevLookup);
                standaloneModels[model.id] = toOpenCodeModel(
                  model,
                  providerId,
                  baseURL,
                  defaultContextWindow,
                  defaultMaxOutputTokens,
                  enriched,
                  apiKey
                );
              }
            }
            // Also include any explicitly configured static standalone models
            for (const [id, m] of Object.entries(staticModels)) {
              const [alias] = splitProviderAlias(id);
              if (!alias) standaloneModels[id] = m;
            }
            process.stderr.write(
              `[opencode-9router-plugin] models hook (sub-providers active): ` +
                `${Object.keys(standaloneModels).length} standalone model(s)\n`
            );
            return standaloneModels;
          }

          // ----------------------------------------------------------------
          // Fallback: config hook did not inject sub-providers (no API key at
          // config time, or API was unreachable).  Return all models as a flat
          // list under the main provider group.
          // ----------------------------------------------------------------
          const modelsDevCatalog = await fetchModelsDevCatalog(
            modelsDevCatalogURL,
            modelsDevTimeoutMs,
            modelsDevCacheTtlMs
          );
          const modelsDevLookup = modelsDevCatalog ? buildModelsDevLookup(modelsDevCatalog) : undefined;

          const upstreamModels = await fetchModels(baseURL, apiKey);
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
            .filter((model) => regexPass(includeModelIdRegex, model.id))
            .filter((model) => !excludeModelIdRegex || !regexPass(excludeModelIdRegex, model.id))
            .reduce<Record<string, OpenCodeModel>>((acc, model) => {
              const enriched = findEnrichedModel(model.id, modelsDevLookup);
              acc[model.id] = toOpenCodeModel(
                model,
                providerId,
                baseURL,
                defaultContextWindow,
                defaultMaxOutputTokens,
                enriched,
                apiKey
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
          const settings = await readSettings(providerId);
          return {
            apiKey: pickApiKey(process.env[apiKeyEnvName], auth, (provider as ProviderConfig | undefined)?.key),
            baseURL: pickBaseURL(provider as ProviderConfig | undefined, defaultBaseURL, settings.baseURL)
          };
        },
        methods: [
          {
            type: "api",
            label: "Login with 9Router API key",
            prompts: [
              {
                type: "text",
                key: "baseURL",
                message: "Enter your 9Router base URL",
                placeholder: defaultBaseURL,
                validate: validateBaseURL
              },
              {
                type: "text",
                key: "key",
                message: "Enter your 9Router API key",
                placeholder: "sk-...",
                validate: (value: string) => {
                  if (!value.trim()) return "API key is required";
                  return undefined;
                }
              }
            ],
            authorize: async (inputs = {}) => {
              const baseURLInput = typeof inputs.baseURL === "string" ? inputs.baseURL : defaultBaseURL;
              const error = validateBaseURL(baseURLInput);
              if (!error) {
                await writeSettings(providerId, { baseURL: normalizeBaseURLInput(baseURLInput) });
              }
              // Ensure opencode.json has this provider listed so opencode will
              // call the provider.models hook. Without this entry opencode never
              // invokes the hook and no models are discovered.
              await ensureProviderInOpenCodeConfig(providerId);
              // Persist the API key to settings so the config hook can use it
              // on next startup (before provider.models is called).
              const apiKey = typeof inputs.key === "string" && inputs.key ? inputs.key : undefined;
              if (apiKey) {
                await writeSettings(providerId, { baseURL: normalizeBaseURLInput(baseURLInput), apiKey }).catch(() => undefined);
              }
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
