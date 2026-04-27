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
      key: string;
      provider?: string;
    } | {
      type: "failed";
    }>;
  }>;
}

export interface Hooks {
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
  defaultBaseURL: "https://api.openai.com/v1",
  apiKeyEnvName: "ROUTER9_API_KEY",
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192,
  modelsDevCatalogURL: "https://models.dev/api.json",
  modelsDevTimeoutMs: 3000,
  modelsDevCacheTtlMs: 10 * 60 * 1000
};

type PluginSettings = {
  baseURL?: string;
};

type ModelsDevCache = {
  url: string;
  expiresAt: number;
  data: ModelsDevCatalog;
};

let modelsDevCache: ModelsDevCache | undefined;

const PROVIDER_ALIAS_TO_NAME: Record<string, string> = {
  "9router": "9Router",
  openai: "OpenAI",
  cx: "Codex",
  codex: "Codex",
  cc: "Claude",
  claude: "Claude",
  gc: "Gemini",
  gemini: "Gemini",
  google: "Google",
  qw: "Qwen",
  qwen: "Qwen",
  gl: "GitHub Copilot",
  github: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  op: "OpenCode",
  opencode: "OpenCode",
  if: "IFlow",
  iflow: "IFlow",
  iflowcn: "IFlow"
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

function toDisplayProviderName(providerAlias: string): string {
  const normalized = canonicalVariant(providerAlias);
  if (!normalized) {
    return "Unknown";
  }

  const mapped = PROVIDER_ALIAS_TO_NAME[normalized];
  if (mapped) {
    return mapped;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function splitProviderAndModelId(modelId: string): { providerAlias?: string; modelLabel: string } {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return { modelLabel: modelId };
  }

  for (const separator of ["/", ":"]) {
    const idx = trimmed.indexOf(separator);
    if (idx > 0 && idx < trimmed.length - 1) {
      return {
        providerAlias: trimmed.slice(0, idx),
        modelLabel: trimmed.slice(idx + 1)
      };
    }
  }

  return { modelLabel: trimmed };
}

function toOpenCodeModel(
  upstream: UpstreamModel,
  providerId: string,
  baseURL: string,
  contextWindow: number,
  maxOutputTokens: number,
  enriched?: ModelsDevModel
): OpenCodeModel {
  const family =
    typeof enriched?.family === "string" && enriched.family.trim()
      ? enriched.family
      : inferFamily(upstream.id);
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
  const parsedId = splitProviderAndModelId(upstream.id);
  const providerLabel = toDisplayProviderName(parsedId.providerAlias ?? providerId);
  const modelLabel =
    typeof enriched?.name === "string" && enriched.name.trim()
      ? enriched.name.trim()
      : parsedId.modelLabel || upstream.id;

  const attachment = typeof enriched?.attachment === "boolean" ? enriched.attachment : false;
  const reasoning =
    typeof enriched?.reasoning === "boolean" ? enriched.reasoning : family === "o1" || family === "o3";
  const temperature = typeof enriched?.temperature === "boolean" ? enriched.temperature : true;
  const toolcall = typeof enriched?.tool_call === "boolean" ? enriched.tool_call : true;

  return {
    id: upstream.id,
    name: `${providerLabel} - ${modelLabel}`,
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
    headers: {}
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
  if (auth?.type === "api" && typeof auth.key === "string") {
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

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      console.warn(
        `[opencode-9router-plugin] model discovery failed (${response.status} ${response.statusText})`
      );
      return null;
    }

    const payload = (await response.json()) as unknown;
    if (!isValidModelList(payload)) {
      console.warn("[opencode-9router-plugin] model discovery failed (invalid /models schema)");
      return null;
    }

    return payload.data;
  } catch {
    console.warn("[opencode-9router-plugin] model discovery failed (request error)");
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

  return async (_input: PluginInput): Promise<Hooks> => ({
    provider: {
      id: providerId,
      models: async (
        provider: ProviderConfig,
        context?: { auth?: { type?: string; key?: string } }
      ): Promise<Record<string, OpenCodeModel>> => {
        const staticModels = provider.models ?? {};
        const modelsDevCatalog = await fetchModelsDevCatalog(
          modelsDevCatalogURL,
          modelsDevTimeoutMs,
          modelsDevCacheTtlMs
        );
        const modelsDevLookup = modelsDevCatalog ? buildModelsDevLookup(modelsDevCatalog) : undefined;
        const settings = await readSettings(providerId);
        const apiKey = pickApiKey(process.env[apiKeyEnvName], context?.auth, provider.key);

        if (!apiKey) {
          return staticModels;
        }

        const baseURL = pickBaseURL(provider, defaultBaseURL, settings.baseURL);

        const upstreamModels = await fetchModels(baseURL, apiKey);
        if (!upstreamModels) {
          return staticModels;
        }

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
              enriched
            );
            return acc;
          }, {});

        return {
          ...staticModels,
          ...dynamicModels
        };
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
          label: "Login with OpenAI-compatible API key",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Enter your API key",
              placeholder: "sk-...",
              validate: (value: string) => (!value.trim() ? "API key is required" : undefined)
            },
            {
              type: "text",
              key: "baseURL",
              message: "Enter your OpenAI-compatible base URL",
              placeholder: defaultBaseURL,
              validate: validateBaseURL
            }
          ],
          authorize: async (inputs = {}) => {
            const apiKey = typeof inputs.key === "string" ? inputs.key.trim() : "";
            if (!apiKey) {
              return { type: "failed" };
            }
            const baseURLInput = typeof inputs.baseURL === "string" ? inputs.baseURL : defaultBaseURL;
            const error = validateBaseURL(baseURLInput);
            if (!error) {
              await writeSettings(providerId, { baseURL: normalizeBaseURLInput(baseURLInput) });
            }
            return { type: "success", key: apiKey };
          }
        }
      ]
    }
  });
}

const plugin = createOpenAICompatibleModelsPlugin();

export default { id: "9router", server: plugin } satisfies PluginModule;
