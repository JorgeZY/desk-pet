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
import { modelParameterEnabled } from "../../shared/model-parameters";

export const LLAMA_CPP_MODEL_ALIAS = "desk-pet-model";
export const LLAMA_CPP_PROVIDER_METADATA_KEY = "llamaCpp";

// llama.cpp rejects a generated GBNF rule when a finite repetition reaches
// its 2,000-rule safety threshold. Some releases also reject larger bounds
// before they can be treated as unbounded. Keep the original schemas on the
// executable tools and only relax incompatible bounds in the wire request.
const LLAMA_CPP_GRAMMAR_REPETITION_THRESHOLD = 2_000;
const GRAMMAR_REPETITION_KEYWORDS = new Set([
  "maxItems",
  "maxLength",
  "maxProperties",
  "minItems",
  "minLength",
  "minProperties",
]);

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export interface LlamaModelAdapterOptions {
  thinking?: boolean;
  thinkingEffort?: ThinkingEffort;
  fetch?: OpenAICompatibleProviderSettings["fetch"];
}

export type LlamaModelAdapterSettings = Pick<
  LanguageModelCallOptions,
  "maxOutputTokens"
> & Partial<Pick<
  LanguageModelCallOptions,
  "temperature" | "topP" | "presencePenalty"
>> & {
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
      const compatibleTools = llamaCppCompatibleTools(body.tools);
      return {
        ...body,
        ...(compatibleTools === undefined ? {} : { tools: compatibleTools }),
        ...(modelParameterEnabled(config, "topK") ? { top_k: config.topK } : {}),
        ...(modelParameterEnabled(config, "minP") ? { min_p: config.minP } : {}),
        ...(modelParameterEnabled(config, "repeatPenalty")
          ? { repeat_penalty: config.repeatPenalty }
          : {}),
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
      ...(modelParameterEnabled(config, "temperature")
        ? { temperature: config.temperature }
        : {}),
      ...(modelParameterEnabled(config, "topP") ? { topP: config.topP } : {}),
      ...(modelParameterEnabled(config, "presencePenalty")
        ? { presencePenalty: config.presencePenalty }
        : {}),
      maxRetries: 0,
    },
  };
}

/**
 * Downlevels only the serialized tool schemas sent to llama.cpp. Executable
 * tools retain their original schemas and existing executor-side checks even
 * when the model-facing grammar representation must be less precise.
 */
export function llamaCppCompatibleTools(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function)) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: llamaCppCompatibleSchema(tool.function.parameters),
      },
    };
  });
}

function llamaCppCompatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(llamaCppCompatibleSchema);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      GRAMMAR_REPETITION_KEYWORDS.has(key)
      && typeof child === "number"
      && Number.isFinite(child)
      && child >= LLAMA_CPP_GRAMMAR_REPETITION_THRESHOLD
    ) {
      continue;
    }
    result[key] = llamaCppCompatibleSchema(child);
  }

  // Several llama.cpp releases generate invalid GBNF for a strict object with
  // zero properties. `{ type: "object" }` represents the same no-argument tool
  // at the model boundary while the original executable schema stays strict.
  if (
    result.type === "object"
    && isRecord(result.properties)
    && Object.keys(result.properties).length === 0
  ) {
    delete result.properties;
    if (Array.isArray(result.required) && result.required.length === 0) {
      delete result.required;
    }
    if (result.additionalProperties === false) delete result.additionalProperties;
  }

  return result;
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
