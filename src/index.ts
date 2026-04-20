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
  loader: () => Promise<{ apiKey: string }>;
}

export interface Hooks {
  provider: {
    models: (provider: ProviderConfig) => Promise<Record<string, OpenCodeModel>>;
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

function normalizeModelsURL(baseURL: string): string {
  const clean = baseURL.replace(/\/+$/, "");
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
      models: async (provider: ProviderConfig): Promise<Record<string, OpenCodeModel>> => {
        const staticModels = provider.models ?? {};
        const apiKey = process.env[apiKeyEnvName] ?? "";

        if (!apiKey) {
          return staticModels;
        }

        const baseURL =
          (typeof provider.api === "string" && provider.api.trim()) ||
          (typeof provider.baseURL === "string" && provider.baseURL.trim()) ||
          defaultBaseURL;

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
      loader: async () => ({
        apiKey: process.env[apiKeyEnvName] ?? ""
      })
    }
  });
}

const plugin = createOpenAICompatibleModelsPlugin();

export default plugin;
