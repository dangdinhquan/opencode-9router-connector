import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RouterPluginOptions {
  providerId?: string;
  defaultBaseURL?: string;
  apiKeyEnvName?: string;
  defaultContextWindow?: number;
  defaultMaxOutputTokens?: number;
  includeModelIdRegex?: RegExp;
  excludeModelIdRegex?: RegExp;
}

export interface OpenCodeModel {
  id: string;
  name: string;
  family: string;
  release_date: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  limit: {
    context: number;
    output: number;
  };
}

export interface ProviderConfig {
  api?: string;
  baseURL?: string;
  models?: Record<string, OpenCodeModel>;
  [key: string]: unknown;
}

export interface AuthHook {
  provider: string;
  loader: (
    getAuth: () => Promise<{ type?: string; key?: string }>,
    provider: ProviderConfig
  ) => Promise<{ apiKey: string; baseURL: string }>;
  methods: Array<{
    type: "api";
    label: string;
    prompts: Array<{
      type: "text";
      key: "baseURL";
      message: string;
      placeholder: string;
      validate: (value: string) => string | undefined;
    }>;
    authorize: (inputs?: Record<string, string>) => Promise<{
      type: "success";
      key?: string;
      provider?: string;
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

type UpstreamModel = {
  id: string;
  created?: number;
};

type UpstreamModelList = {
  object: "list";
  data: UpstreamModel[];
};

const DEFAULT_OPTIONS: Required<
  Omit<RouterPluginOptions, "includeModelIdRegex" | "excludeModelIdRegex">
> = {
  providerId: "myopenai",
  defaultBaseURL: "https://api.openai.com/v1",
  apiKeyEnvName: "MYOPENAI_API_KEY",
  defaultContextWindow: 128000,
  defaultMaxOutputTokens: 8192
};

type PluginSettings = {
  baseURL?: string;
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

function toOpenCodeModel(
  upstream: UpstreamModel,
  contextWindow: number,
  maxOutputTokens: number
): OpenCodeModel {
  const family = inferFamily(upstream.id);

  return {
    id: upstream.id,
    name: upstream.id,
    family,
    release_date: toDate(upstream.created),
    attachment: false,
    reasoning: family === "o1" || family === "o3",
    temperature: true,
    tool_call: true,
    limit: {
      context: contextWindow,
      output: maxOutputTokens
    }
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
  auth?: { type?: string; key?: string }
): string {
  if (envApiKey) {
    return envApiKey;
  }
  if (auth?.type === "api" && typeof auth.key === "string") {
    return auth.key;
  }
  return "";
}

function pickBaseURL(
  provider: ProviderConfig,
  defaultBaseURL: string,
  persistedBaseURL?: string
): string {
  const api =
    typeof provider.api === "string" && provider.api.trim()
      ? normalizeBaseURLInput(provider.api)
      : undefined;
  if (api) {
    return api;
  }

  const baseURL =
    typeof provider.baseURL === "string" && provider.baseURL.trim()
      ? normalizeBaseURLInput(provider.baseURL)
      : undefined;
  if (baseURL) {
    return baseURL;
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

export function createOpenAICompatibleModelsPlugin(options: RouterPluginOptions = {}) {
  const {
    providerId,
    defaultBaseURL,
    apiKeyEnvName,
    defaultContextWindow,
    defaultMaxOutputTokens,
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
        const settings = await readSettings(providerId);
        const apiKey = pickApiKey(process.env[apiKeyEnvName], context?.auth);

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
            acc[model.id] = toOpenCodeModel(
              model,
              defaultContextWindow,
              defaultMaxOutputTokens
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
          apiKey: pickApiKey(process.env[apiKeyEnvName], auth),
          baseURL: pickBaseURL(provider, defaultBaseURL, settings.baseURL)
        };
      },
      methods: [
        {
          type: "api",
          label: "Login with OpenAI-compatible API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "Enter your OpenAI-compatible base URL",
              placeholder: defaultBaseURL,
              validate: validateBaseURL
            }
          ],
          authorize: async (inputs = {}) => {
            const baseURLInput = typeof inputs.baseURL === "string" ? inputs.baseURL : defaultBaseURL;
            const error = validateBaseURL(baseURLInput);
            if (!error) {
              await writeSettings(providerId, { baseURL: normalizeBaseURLInput(baseURLInput) });
            }
            return { type: "success" };
          }
        }
      ]
    }
  });
}

const plugin = createOpenAICompatibleModelsPlugin();

export default plugin;
