import type { FetchFunction } from "@ai-sdk/provider-utils";

const TOKEN_COUNT_TIMEOUT_MS = 5_000;
const DOCUMENT_TRUNCATION_SUFFIX = "\n[附件内容过长，已截断]";

type JsonObject = Record<string, unknown>;

interface OpenAiMessage extends JsonObject {
  role: string;
  content?: unknown;
}

export interface ExactContextBudgetOptions {
  contextSize: number;
  maxOutputTokens: number;
  fetch?: FetchFunction;
  onWarning?: (message: string) => void;
}

export class ExactTokenCounterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExactTokenCounterError";
  }
}

export class ContextBudgetExceededError extends Error {
  constructor(requiredTokens: number, availableTokens: number) {
    super(
      `当前输入需要 ${requiredTokens.toLocaleString("en-US")} token，`
      + `但本轮仅有 ${availableTokens.toLocaleString("en-US")} token 可用。`
      + "请缩短当前输入或在设置中增大上下文。",
    );
    this.name = "ContextBudgetExceededError";
  }
}

/**
 * Wraps the provider fetch after AI SDK serialization, so counting and the
 * actual request use exactly the same OpenAI-compatible body.
 */
export function createExactContextBudgetFetch(
  options: ExactContextBudgetOptions,
): FetchFunction {
  const requestFetch = options.fetch ?? globalThis.fetch;
  let historyWarningSent = false;
  let documentWarningSent = false;

  return async (input, init) => {
    const url = requestUrl(input);
    if (!isChatCompletionUrl(url) || typeof init?.body !== "string") {
      return requestFetch(input, init);
    }

    const body = parseRequestBody(init.body);
    const inputBudget = Math.max(
      0,
      Math.floor(options.contextSize) - Math.max(0, Math.floor(options.maxOutputTokens)),
    );
    const fitted = await fitRequestToContext({
      body,
      count: (candidate) => countInputTokens(
        tokenCountUrl(url),
        candidate,
        init.headers,
        init.signal,
        requestFetch,
      ),
      inputBudget,
    });

    if (fitted.omittedTurns > 0 && !historyWarningSent) {
      historyWarningSent = true;
      options.onWarning?.(
        `上下文已按 ${options.contextSize.toLocaleString("en-US")} token 预算裁剪，`
        + `已省略 ${fitted.omittedTurns} 个较早对话轮次。`,
      );
    }
    if (fitted.documentsTruncated && !documentWarningSent) {
      documentWarningSent = true;
      options.onWarning?.(
        `附件内容已按 ${options.contextSize.toLocaleString("en-US")} token 上下文预算截断，`
        + "优先保留当前输入与最近附件。",
      );
    }

    return requestFetch(input, { ...init, body: JSON.stringify(fitted.body) });
  };
}

export async function probeExactTokenCounter(
  endpoint: string,
  options: { fetch?: FetchFunction; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const root = endpoint.replace(/\/+$/, "");
  await countInputTokens(
    `${root}/v1/chat/completions/input_tokens`,
    {
      model: "desk-pet-model",
      messages: [{ role: "user", content: "token counter probe" }],
    },
    { "content-type": "application/json" },
    options.signal,
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? TOKEN_COUNT_TIMEOUT_MS,
  );
}

interface FitRequestOptions {
  body: JsonObject;
  inputBudget: number;
  count: (body: JsonObject) => Promise<number>;
}

interface FittedRequest {
  body: JsonObject;
  omittedTurns: number;
  documentsTruncated: boolean;
}

export async function fitRequestToContext(
  options: FitRequestOptions,
): Promise<FittedRequest> {
  const messages = requestMessages(options.body);
  const fullTokens = await options.count(options.body);
  if (fullTokens <= options.inputBudget) {
    return { body: options.body, omittedTurns: 0, documentsTruncated: false };
  }

  const { fixed, turns } = splitTurns(messages);
  if (turns.length === 0) {
    throw new ContextBudgetExceededError(fullTokens, options.inputBudget);
  }
  const latestOnly = withMessages(options.body, [...fixed, ...turns.at(-1)!]);
  const latestTokens = await options.count(latestOnly);
  if (latestTokens > options.inputBudget) {
    const fittedLatest = await fitGeneratedDocuments(
      latestOnly,
      options.inputBudget,
      options.count,
    );
    return {
      body: fittedLatest.body,
      omittedTurns: Math.max(0, turns.length - 1),
      documentsTruncated: fittedLatest.truncated,
    };
  }

  let low = 0;
  let high = turns.length - 1;
  let bestStart = high;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = withMessages(options.body, [
      ...fixed,
      ...turns.slice(middle).flat(),
    ]);
    const tokens = await options.count(candidate);
    if (tokens <= options.inputBudget) {
      bestStart = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  let fittedBody = withMessages(options.body, [
    ...fixed,
    ...turns.slice(bestStart).flat(),
  ]);
  while (bestStart < turns.length - 1 && await options.count(fittedBody) > options.inputBudget) {
    bestStart += 1;
    fittedBody = withMessages(options.body, [
      ...fixed,
      ...turns.slice(bestStart).flat(),
    ]);
  }
  return {
    body: fittedBody,
    omittedTurns: bestStart,
    documentsTruncated: false,
  };
}

async function fitGeneratedDocuments(
  body: JsonObject,
  inputBudget: number,
  count: (body: JsonObject) => Promise<number>,
): Promise<{ body: JsonObject; truncated: boolean }> {
  const documents = documentParts(requestMessages(body));
  if (!documents.length) {
    throw new ContextBudgetExceededError(await count(body), inputBudget);
  }

  const withoutDocuments = withDocumentCharacterBudget(body, 0);
  const requiredTokens = await count(withoutDocuments);
  if (requiredTokens > inputBudget) {
    throw new ContextBudgetExceededError(requiredTokens, inputBudget);
  }

  const totalCharacters = documents.reduce((total, document) => total + document.text.length, 0);
  let low = 0;
  let high = totalCharacters;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = withDocumentCharacterBudget(body, middle);
    const tokens = await count(candidate);
    if (tokens <= inputBudget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  let fitted = withDocumentCharacterBudget(body, best);
  while (best > 0 && await count(fitted) > inputBudget) {
    best -= 1;
    fitted = withDocumentCharacterBudget(body, best);
  }
  return { body: fitted, truncated: best < totalCharacters };
}

function withDocumentCharacterBudget(body: JsonObject, characterBudget: number): JsonObject {
  let remaining = Math.max(0, Math.floor(characterBudget));
  const cloned = cloneBody(body);
  const messages = requestMessages(cloned);

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const nextContent: unknown[] = [];
    for (const part of message.content) {
      if (!isGeneratedDocumentPart(part)) {
        nextContent.push(part);
        continue;
      }
      if (remaining <= 0) continue;
      const text = part.text;
      const allowance = Math.min(remaining, text.length);
      nextContent.push({
        ...part,
        text: allowance < text.length
          ? allowance <= DOCUMENT_TRUNCATION_SUFFIX.length
            ? DOCUMENT_TRUNCATION_SUFFIX.slice(0, allowance)
            : `${text.slice(0, allowance - DOCUMENT_TRUNCATION_SUFFIX.length)}${DOCUMENT_TRUNCATION_SUFFIX}`
          : text,
      });
      remaining -= allowance;
    }
    message.content = nextContent;
  }
  return cloned;
}

function documentParts(messages: readonly OpenAiMessage[]): Array<{ text: string }> {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return [];
    return message.content.filter(isGeneratedDocumentPart);
  });
}

function isGeneratedDocumentPart(value: unknown): value is JsonObject & { text: string } {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "text"
    && typeof (value as { text?: unknown }).text === "string"
    && (value as { text: string }).text.startsWith("<document name=\""),
  );
}

async function countInputTokens(
  url: string,
  body: JsonObject,
  headers: HeadersInit | undefined,
  parentSignal: AbortSignal | null | undefined,
  requestFetch: FetchFunction,
  timeoutMs = TOKEN_COUNT_TIMEOUT_MS,
): Promise<number> {
  const signal = combinedSignal(parentSignal ?? undefined, timeoutMs);
  let response: Response;
  try {
    response = await requestFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: false, stream_options: undefined }),
      signal,
    });
  } catch (error) {
    if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ExactTokenCounterError(
      "无法访问 llama.cpp 精确 token 计数接口；请确认服务版本支持 /v1/chat/completions/input_tokens。",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new ExactTokenCounterError(
      `当前 llama.cpp 不支持精确 token 计数（HTTP ${response.status}）；请升级 llama.cpp。`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new ExactTokenCounterError("llama.cpp token 计数接口返回了无效 JSON。", { cause: error });
  }
  const tokens = value && typeof value === "object"
    ? (value as { input_tokens?: unknown }).input_tokens
    : undefined;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    throw new ExactTokenCounterError("llama.cpp token 计数接口未返回有效的 input_tokens。");
  }
  return Math.floor(tokens);
}

function requestMessages(body: JsonObject): OpenAiMessage[] {
  if (!Array.isArray(body.messages)) {
    throw new ExactTokenCounterError("模型请求缺少可计数的 messages。");
  }
  return body.messages.filter((message): message is OpenAiMessage =>
    Boolean(message && typeof message === "object" && typeof message.role === "string"));
}

function splitTurns(messages: readonly OpenAiMessage[]): {
  fixed: OpenAiMessage[];
  turns: OpenAiMessage[][];
} {
  const fixed = messages.filter((message) => message.role === "system");
  const turns: OpenAiMessage[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return { fixed, turns };
}

function withMessages(body: JsonObject, messages: OpenAiMessage[]): JsonObject {
  return { ...body, messages };
}

function cloneBody(body: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(body)) as JsonObject;
}

function parseRequestBody(body: string): JsonObject {
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  } catch (error) {
    throw new ExactTokenCounterError("无法解析 AI SDK 模型请求以计算上下文预算。", { cause: error });
  }
  throw new ExactTokenCounterError("AI SDK 模型请求不是 JSON 对象，无法计算上下文预算。");
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function isChatCompletionUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/chat/completions");
  } catch {
    return false;
  }
}

function tokenCountUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname}/input_tokens`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
