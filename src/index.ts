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
  server?: (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;
  setup?: (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;
  effect?: (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;
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

// ... rest of file unchanged ...

const plugin = createOpenAICompatibleModelsPlugin();

const pluginDefinition: PluginModule = {
  id: "9router",
  server: async (input, options) => plugin(input, options),
  setup: async (input, options) => plugin(input, options),
  effect: async (input, options) => plugin(input, options)
};

export default pluginDefinition;
