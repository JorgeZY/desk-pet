import { createOpenAICompatible, type MetadataExtractor, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import type {
  LanguageModel,
  LanguageModelCallOptions,
  LanguageModelUsage,
  ProviderMetadata,
} from "ai";
import type {
  ChatContextUsage,
  RuntimeConfig,
  ThinkingEffort,
} from "../../shared/types";
import { thinkingBudgetFor } from "../../shared/thinking-effort";

export const LLAMA_CPP_MODEL_ALIAS = "desk-pet-model";
export const LLAMA_CPP_PROVIDER_METADATA_KEY = "llamaCpp";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export interface LlamaModelAdapterOptions {
  thinking?: boolean;
  thinkingEffort?: ThinkingEffort;
  fetch?: OpenAICompatibleProviderSettings["fetch"];
}

export type LlamaModelAdapterSettings = Required<
  Pick<
    LanguageModelCallOptions,
    "maxOutputTokens" | "temperature" | "topP" | "presencePenalty"
  >
> & {
  maxRetries: 0;
};

export interface LlamaModelAdapter {
  model: LanguageModel;
  settings: LlamaModelAdapterSettings;
}

export interface LlamaModelStepMetadata {
  timings?: Record<string, unknown>;
  contextUsage?: ChatContextUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value as JsonObject : undefined;
}

function completionMetadata(value: unknown): {
  timings?: JsonObject;
  usage?: JsonObject;
} {
  if (!isRecord(value)) return {};
  return {
    timings: asJsonObject(value.timings),
    usage: asJsonObject(value.usage),
  };
}

function providerMetadata(
  timings?: JsonObject,
  usage?: JsonObject,
): ProviderMetadata | undefined {
  if (!timings && !usage) return undefined;
  return {
    [LLAMA_CPP_PROVIDER_METADATA_KEY]: {
      ...(timings ? { timings } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}

function createMetadataExtractor(): MetadataExtractor {
  return {
    extractMetadata: async ({ parsedBody }) => {
      const { timings, usage } = completionMetadata(parsedBody);
      return providerMetadata(timings, usage);
    },
    createStreamExtractor: () => {
      let timings: JsonObject | undefined;
      let usage: JsonObject | undefined;
      return {
        processChunk: (chunk) => {
          const metadata = completionMetadata(chunk);
          timings = metadata.timings ?? timings;
          usage = metadata.usage ?? usage;
        },
        buildMetadata: () => providerMetadata(timings, usage),
      };
    },
  };
}

function normalizedApiBaseUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`无效的 llama.cpp endpoint：${endpoint}`);
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("llama.cpp endpoint 必须是本机 HTTP loopback 地址。");
  }
  if (url.username || url.password) {
    throw new Error("llama.cpp endpoint 不应包含凭据。");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function createLlamaModelAdapter(
  config: RuntimeConfig,
  endpoint: string,
  options: LlamaModelAdapterOptions = {},
): LlamaModelAdapter {
  const thinking = options.thinking ?? false;
  const effort = thinking ? (options.thinkingEffort ?? "medium") : "none";
  const provider = createOpenAICompatible({
    name: LLAMA_CPP_PROVIDER_METADATA_KEY,
    baseURL: normalizedApiBaseUrl(endpoint),
    includeUsage: true,
    fetch: options.fetch,
    metadataExtractor: createMetadataExtractor(),
    transformRequestBody: (body) => {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return {
        ...body,
        top_k: config.topK,
        min_p: config.minP,
        repeat_penalty: config.repeatPenalty,
        reasoning_effort: effort,
        thinking_budget_tokens: thinking
          ? thinkingBudgetFor(options.thinkingEffort ?? "medium", config.maxTokens)
          : 0,
        chat_template_kwargs: {
          enable_thinking: thinking,
          reasoning_effort: effort,
        },
        ...(hasTools ? { parallel_tool_calls: false } : {}),
      };
    },
  });

  return {
    model: provider(LLAMA_CPP_MODEL_ALIAS),
    settings: {
      maxOutputTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
      presencePenalty: config.presencePenalty,
      maxRetries: 0,
    },
  };
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function extractLlamaModelStepMetadata(
  providerData?: ProviderMetadata,
  usage?: LanguageModelUsage,
): LlamaModelStepMetadata {
  const metadata = providerData?.[LLAMA_CPP_PROVIDER_METADATA_KEY];
  const timings = isRecord(metadata?.timings)
    ? metadata.timings as Record<string, unknown>
    : undefined;
  const rawUsage = isRecord(metadata?.usage) ? metadata.usage : undefined;
  const cachedPromptTokens = nonNegativeTokenCount(timings?.cache_n)
    ?? nonNegativeTokenCount(timings?.tokens_cached)
    ?? 0;
  const promptTokens = nonNegativeTokenCount(usage?.inputTokens)
    ?? nonNegativeTokenCount(rawUsage?.prompt_tokens)
    ?? (() => {
      const processedPromptTokens = nonNegativeTokenCount(timings?.prompt_n);
      return processedPromptTokens === undefined
        ? undefined
        : cachedPromptTokens + processedPromptTokens;
    })();
  const completionTokens = nonNegativeTokenCount(usage?.outputTokens)
    ?? nonNegativeTokenCount(rawUsage?.completion_tokens)
    ?? nonNegativeTokenCount(timings?.predicted_n);

  if (promptTokens === undefined && completionTokens === undefined) {
    return { timings };
  }

  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    timings,
    contextUsage: {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: nonNegativeTokenCount(usage?.totalTokens)
        ?? nonNegativeTokenCount(rawUsage?.total_tokens)
        ?? prompt + completion,
    },
  };
}
