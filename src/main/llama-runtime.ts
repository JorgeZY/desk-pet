import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ChatEvent,
  ChatImageMimeType,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  ChatToolDefinition,
  ModelDownloadProgress,
  RuntimeConfig,
  RuntimeState,
  ThinkingEffort,
} from "../shared/types";
import { formatBytes, type ResolveModelOptions } from "./model-downloader";
import { SseDecoder } from "./sse";
import { thinkingBudgetFor } from "../shared/thinking-effort";
import { prepareMcpServersConfigContents } from "./mcp-servers-config";

const MODEL_ALIAS = "desk-pet-model";
const MAX_CHAT_REQUEST_IMAGES = 4;
const MAX_CHAT_REQUEST_IMAGE_BYTES = 10 * 1024 * 1024;
const CHAT_CONTEXT_SAFETY_TOKENS = 256;
const CHAT_MESSAGE_OVERHEAD_TOKENS = 16;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<ChatImageMimeType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

type ApiMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

interface ApiChatMessage {
  role: "system" | ChatMessage["role"] | "tool";
  content: ApiMessageContent | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
}

interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ServerTool {
  tool: string;
  displayName: string;
  requiresApproval: boolean;
  definition: Record<string, unknown>;
  source: ChatToolDefinition["source"];
}

interface StreamCompletionResult {
  toolCalls: ApiToolCall[];
  timings?: Record<string, unknown>;
}

type ImageReader = (path: string) => Promise<Uint8Array>;
type ImageSizer = (path: string) => Promise<number>;

interface BuildChatCompletionOptions {
  visionEnabled?: boolean;
  readImage?: ImageReader;
  getImageSize?: ImageSizer;
  onWarning?: (message: string) => void;
}

export async function buildChatCompletionMessages(
  config: RuntimeConfig,
  messages: ChatMessage[],
  options: BuildChatCompletionOptions = {},
): Promise<ApiChatMessage[]> {
  const recentMessages = messages.slice(-20);
  const warnings = new Set<string>();
  const warn = (message: string): void => {
    if (warnings.has(message)) return;
    warnings.add(message);
    options.onWarning?.(message);
  };
  const textContents = contentWithBudgetedDocuments(config, recentMessages, warn);
  const converted: ApiChatMessage[] = recentMessages.map((message) => ({
    role: message.role,
    content: message.role === "user" ? textContents.get(message.id) ?? message.content : message.content,
  }));
  const visionEnabled = options.visionEnabled ?? Boolean(config.mmprojPath);
  if (!visionEnabled) {
    return expandChatCompletionMessages(config, recentMessages, converted);
  }

  const readImage = options.readImage ?? fs.readFile;
  const getImageSize = options.getImageSize ?? (async (path: string) => (await fs.stat(path)).size);
  let requestImageCount = 0;
  let requestImageBytes = 0;

  // Start with the newest turns so the current prompt wins when history contains many images.
  for (let messageIndex = recentMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = recentMessages[messageIndex];
    const images = message.images ?? [];
    if (!images.length) continue;

    const content: Exclude<ApiMessageContent, string> = [];
    const textContent = textContents.get(message.id) ?? message.content;
    if (textContent.trim()) content.push({ type: "text", text: textContent });

    for (const image of images) {
      if (requestImageCount >= MAX_CHAT_REQUEST_IMAGES) {
        warn("为保护内存，本次请求仅发送最近 4 张图片，较早图片已跳过。");
        break;
      }
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
        warn(`图片 ${image.name} 的格式不受支持，已跳过。`);
        continue;
      }

      let declaredBytes: number;
      try {
        declaredBytes = await getImageSize(image.path);
      } catch {
        warn(`历史图片 ${image.name} 已不可用，已跳过。`);
        continue;
      }
      if (declaredBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn(`图片 ${image.name} 超过 10 MB，已跳过。`);
        continue;
      }
      if (requestImageBytes + declaredBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn("为保护内存，本次请求图片合计不超过 10 MB，较早图片已跳过。");
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readImage(image.path);
      } catch {
        warn(`历史图片 ${image.name} 已不可用，已跳过。`);
        continue;
      }
      const effectiveBytes = Math.max(declaredBytes, bytes.byteLength);
      if (effectiveBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn(`图片 ${image.name} 超过 10 MB，已跳过。`);
        continue;
      }
      if (requestImageBytes + effectiveBytes > MAX_CHAT_REQUEST_IMAGE_BYTES) {
        warn("为保护内存，本次请求图片合计不超过 10 MB，较早图片已跳过。");
        continue;
      }

      content.push({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        },
      });
      requestImageCount += 1;
      requestImageBytes += effectiveBytes;
    }

    if (content.some((item) => item.type === "image_url")) {
      converted[messageIndex] = { role: message.role, content };
    }
  }

  return expandChatCompletionMessages(config, recentMessages, converted);
}

function expandChatCompletionMessages(
  config: RuntimeConfig,
  recentMessages: ChatMessage[],
  converted: ApiChatMessage[],
): ApiChatMessage[] {
  const expanded: ApiChatMessage[] = [{ role: "system", content: config.systemPrompt }];
  for (let index = 0; index < recentMessages.length; index += 1) {
    const message = recentMessages[index];
    if (message.role === "user") {
      expanded.push(converted[index]);
      continue;
    }

    for (const call of message.toolCalls ?? []) {
      if (call.status !== "completed" && call.status !== "denied" && call.status !== "error") continue;
      expanded.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }],
      });
      expanded.push({
        role: "tool",
        content: call.result ?? call.error ?? "工具没有返回内容。",
        tool_call_id: call.id,
      });
    }
    if (message.content || !message.toolCalls?.length) expanded.push(converted[index]);
  }
  return expanded;
}

function contentWithBudgetedDocuments(
  config: RuntimeConfig,
  messages: ChatMessage[],
  warn: (message: string) => void,
): Map<string, string> {
  const tokenUpperBound = (text: string): number => Buffer.byteLength(text, "utf8");
  const truncateToTokenBudget = (text: string, budget: number): string => {
    if (tokenUpperBound(text) <= budget) return text;
    let used = 0;
    let result = "";
    for (const character of text) {
      const size = tokenUpperBound(character);
      if (used + size > budget) break;
      result += character;
      used += size;
    }
    return result;
  };
  const contents = new Map(messages.map((message) => [message.id, message.content]));
  const fixedTokens = tokenUpperBound(config.systemPrompt)
    + Math.min(config.maxTokens, config.contextSize)
    + CHAT_CONTEXT_SAFETY_TOKENS
    + messages.reduce((total, message) => {
      const toolText = (message.toolCalls ?? []).reduce(
        (callTotal, call) => callTotal
          + tokenUpperBound(call.name)
          + tokenUpperBound(call.arguments)
          + tokenUpperBound(call.result ?? "")
          + tokenUpperBound(call.error ?? ""),
        0,
      );
      return total + tokenUpperBound(message.content) + toolText + CHAT_MESSAGE_OVERHEAD_TOKENS;
    }, 0);
  let remainingTokens = Math.max(0, config.contextSize - fixedTokens);
  let contextTruncated = false;

  // Spend the shared budget newest-first so the active prompt and its documents win over history.
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "user" || !message.documents?.length) continue;

    const blocks: string[] = [];
    for (const document of message.documents) {
      const originalAvailableText = document.text;
      const baseTruncated = document.truncated === true;
      const blockFor = (text: string, truncated: boolean): string => {
        const truncation = truncated
          ? `（原文 ${document.characterCount} 字符，当前请求仅包含前 ${text.length} 字符）`
          : "";
        return `<document name="${document.name}">${truncation}\n${text}\n</document>`;
      };

      let text = truncateToTokenBudget(originalAvailableText, remainingTokens);
      let block = blockFor(
        text,
        baseTruncated || text.length < originalAvailableText.length,
      );
      let blockTokens = tokenUpperBound(block);
      const separatorTokens = message.content || blocks.length ? 2 : 0;
      while (text && blockTokens + separatorTokens > remainingTokens) {
        text = truncateToTokenBudget(
          originalAvailableText,
          Math.max(
            0,
            tokenUpperBound(text) - (blockTokens + separatorTokens - remainingTokens),
          ),
        );
        block = blockFor(
          text,
          baseTruncated || text.length < originalAvailableText.length,
        );
        blockTokens = tokenUpperBound(block);
      }

      if (blockTokens + separatorTokens > remainingTokens) {
        contextTruncated = true;
        continue;
      }
      if (text.length < originalAvailableText.length) contextTruncated = true;
      blocks.push(block);
      remainingTokens -= blockTokens + separatorTokens;
    }
    contents.set(message.id, [message.content, ...blocks].filter(Boolean).join("\n\n"));
  }

  if (contextTruncated) {
    warn(`附件内容已按 ${config.contextSize.toLocaleString("en-US")} token 上下文预算截断，优先保留最近消息中的文档。`);
  }
  return contents;
}

export function reasoningBudgetFor(effort: ThinkingEffort, maxTokens: number): number {
  return thinkingBudgetFor(effort, maxTokens);
}

export interface LlamaCommand {
  command: string;
  args: string[];
}

export type ManagedModelResolver = (
  modelId: string,
  options: ResolveModelOptions,
) => Promise<string | null>;

export function buildLlamaCommand(config: RuntimeConfig): LlamaCommand {
  let executable = config.executable.trim();
  let fileName = win32.basename(executable).toLowerCase() || basename(executable).toLowerCase();

  // Some llama.cpp distributions expose newer server-only options on
  // llama-server before the unified `llama serve` entry point. In particular,
  // the Windows winget build can accept --tools through `llama serve` while
  // rejecting --mcp-servers-config. Prefer the dedicated server executable
  // whenever an MCP config is enabled.
  if (config.mcpServersConfigPath && (fileName === "llama" || fileName === "llama.exe")) {
    executable = isAbsolute(executable)
      ? join(dirname(executable), process.platform === "win32" ? "llama-server.exe" : "llama-server")
      : process.platform === "win32"
        ? "llama-server.exe"
        : "llama-server";
    fileName = win32.basename(executable).toLowerCase() || basename(executable).toLowerCase();
  }
  const args: string[] = fileName === "llama" || fileName === "llama.exe" ? ["serve"] : [];

  if (config.modelMode === "huggingface") {
    args.push("-hf", config.hfRepo);
  } else {
    args.push("-m", config.modelPath);
  }
  if (config.mmprojPath) args.push("--mmproj", config.mmprojPath);

  args.push(
    "--host",
    config.host,
    "--port",
    String(config.port),
    "-c",
    String(config.contextSize),
    "-ngl",
    String(config.gpuLayers),
    "-t",
    String(config.threads),
    "-np",
    "1",
    "--alias",
    MODEL_ALIAS,
    "--jinja",
    "--tools",
    "all",
  );
  if (config.mcpServersConfigPath) {
    args.push("--mcp-servers-config", config.mcpServersConfigPath);
  }
  args.push("--cors-origins", "localhost");

  return { command: executable, args };
}

const initialState = (config: RuntimeConfig): RuntimeState => ({
  phase: "stopped",
  visionEnabled: false,
  endpoint: `http://${config.host}:${config.port}`,
  message: "本地模型尚未启动",
  updatedAt: Date.now(),
});

export class LlamaRuntime extends EventEmitter {
  private config: RuntimeConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: RuntimeState;
  private generation = 0;
  private downloadController: AbortController | null = null;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly toolApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
  private toolCatalog: ServerTool[] | null = null;
  private readonly temporaryMcpConfigs = new Set<string>();

  constructor(
    config: RuntimeConfig,
    private readonly resolveManagedModel?: ManagedModelResolver,
  ) {
    super();
    this.config = config;
    this.state = initialState(config);
  }

  updateConfig(config: RuntimeConfig): void {
    this.config = config;
    this.toolCatalog = null;
    if (this.state.phase === "stopped" || this.state.phase === "error") {
      this.setState({
        ...this.state,
        endpoint: this.endpoint,
        updatedAt: Date.now(),
      });
    }
  }

  get snapshot(): RuntimeState {
    return { ...this.state };
  }

  get endpoint(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get hasActiveChat(): boolean {
    return this.abortControllers.size > 0;
  }

  async start(allowDownload = true): Promise<RuntimeState> {
    if (this.state.phase === "ready" || this.state.phase === "starting" || this.state.phase === "downloading") {
      return this.snapshot;
    }
    if (this.state.phase === "error" && this.child) {
      return this.fail("本地模型进程未能退出。请退出桌宠后重试，以免连接到仍被占用的旧进程。");
    }

    if (
      this.config.modelMode === "local" &&
      (!this.config.modelPath || !existsSync(this.config.modelPath))
    ) {
      return this.fail("找不到本地 GGUF 模型，请在设置中重新选择模型文件。");
    }
    if (this.config.mmprojPath && !existsSync(this.config.mmprojPath)) {
      return this.fail("找不到视觉投影模型，请在设置中重新选择 mmproj GGUF 文件。");
    }
    if (isAbsolute(this.config.executable) && !existsSync(this.config.executable)) {
      return this.fail("找不到 llama.cpp 可执行文件，请在设置中重新选择。");
    }

    if (await this.isHealthy(600)) {
      this.setState({
        phase: "ready",
        visionEnabled: Boolean(this.config.mmprojPath),
        endpoint: this.endpoint,
        message: "已连接当前端口上的 llama.cpp 服务",
        externallyManaged: true,
        updatedAt: Date.now(),
      });
      return this.snapshot;
    }

    const currentGeneration = ++this.generation;
    const launchConfig = { ...this.config };

    if (launchConfig.modelMode === "huggingface" && this.resolveManagedModel) {
      this.downloadController = new AbortController();
      this.setState({
        phase: allowDownload ? "downloading" : "starting",
        visionEnabled: false,
        endpoint: this.endpoint,
        message: allowDownload ? "正在连接模型镜像" : "正在检查本地模型缓存",
        lastLog: allowDownload
          ? "应用会优先使用 ModelScope，失败后自动切换 Hugging Face。"
          : undefined,
        updatedAt: Date.now(),
      });
      void this.prepareManagedModel(
        launchConfig,
        currentGeneration,
        this.downloadController,
        allowDownload,
      );
      return this.snapshot;
    }

    void this.launch(launchConfig, currentGeneration);

    return this.snapshot;
  }

  async stop(): Promise<RuntimeState> {
    this.generation += 1;
    this.downloadController?.abort();
    this.downloadController = null;
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    for (const approval of this.toolApprovals.values()) approval.resolve(false);
    this.toolApprovals.clear();
    this.toolCatalog = null;
    await this.cleanupTemporaryMcpConfigs();

    if (!this.child) {
      this.setState(initialState(this.config));
      return this.snapshot;
    }

    const child = this.child;
    this.child = null;
    this.setState({
      ...this.state,
      phase: "stopping",
      visionEnabled: false,
      message: "正在停止本地模型",
      updatedAt: Date.now(),
    });

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });

    this.setState(initialState(this.config));
    return this.snapshot;
  }

  async restart(): Promise<RuntimeState> {
    await this.stop();
    return this.start();
  }

  abortChat(requestId: string): void {
    this.abortControllers.get(requestId)?.abort();
  }

  async listTools(): Promise<ChatToolDefinition[]> {
    if (this.state.phase !== "ready") {
      throw new Error("本地模型尚未就绪，启动模型后才能读取工具列表。");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const tools = await this.getServerTools(controller.signal);
      return tools.map((tool) => ({
        id: tool.tool,
        displayName: tool.displayName,
        source: tool.source,
        requiresApproval: tool.requiresApproval,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  resolveToolApproval(requestId: string, toolCallId: string, approved: boolean): void {
    this.toolApprovals.get(`${requestId}:${toolCallId}`)?.resolve(approved);
  }

  async streamChat(request: ChatRequest, emit: (event: ChatEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(request.requestId, controller);
    emit({ requestId: request.requestId, type: "start" });

    try {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.state.phase !== "ready") throw new Error("本地模型尚未就绪。");
      const messages = await buildChatCompletionMessages(this.config, request.messages, {
        visionEnabled: this.state.visionEnabled,
        onWarning: (message) => emit({ requestId: request.requestId, type: "warning", message }),
      });
      let tools: ServerTool[] = [];
      try {
        tools = await this.getServerTools(controller.signal);
        if (!tools.length) {
          emit({
            requestId: request.requestId,
            type: "warning",
            message: "当前 llama-server 未公开 builtin tools；请使用支持 --tools all 的新版服务。",
          });
        }
      } catch (error) {
        emit({
          requestId: request.requestId,
          type: "warning",
          message: `无法读取 llama-server 工具目录：${error instanceof Error ? error.message : String(error)}`,
        });
      }

      let timings: Record<string, unknown> | undefined;
      for (let turn = 0; turn < 8; turn += 1) {
        const completion = await this.streamCompletion(
          request,
          messages,
          tools,
          controller.signal,
          emit,
        );
        timings = completion.timings ?? timings;
        if (!completion.toolCalls.length) {
          emit({ requestId: request.requestId, type: "done", timings });
          return;
        }

        messages.push({ role: "assistant", content: null, tool_calls: completion.toolCalls });
        for (const apiCall of completion.toolCalls) {
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const tool = tools.find((candidate) => candidate.tool === apiCall.function.name);
          const baseCall: ChatToolCall = {
            id: apiCall.id,
            name: apiCall.function.name,
            displayName: tool?.displayName ?? apiCall.function.name,
            arguments: apiCall.function.arguments,
            status: tool?.requiresApproval ? "pending-approval" : "running",
            requiresApproval: tool?.requiresApproval ?? false,
          };
          emit({ requestId: request.requestId, type: "tool-call", call: baseCall });

          if (!tool) {
            const error = `llama-server 未提供工具 ${apiCall.function.name}。`;
            emit({
              requestId: request.requestId,
              type: "tool-result",
              toolCallId: apiCall.id,
              status: "error",
              error,
            });
            messages.push({ role: "tool", content: error, tool_call_id: apiCall.id });
            continue;
          }

          if (tool.requiresApproval) {
            const approved = await this.waitForToolApproval(
              request.requestId,
              apiCall.id,
              controller.signal,
            );
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (!approved) {
              const result = "用户拒绝了这次写入类工具调用。";
              emit({
                requestId: request.requestId,
                type: "tool-result",
                toolCallId: apiCall.id,
                status: "denied",
                result,
              });
              messages.push({ role: "tool", content: result, tool_call_id: apiCall.id });
              continue;
            }
            emit({
              requestId: request.requestId,
              type: "tool-call",
              call: { ...baseCall, status: "running" },
            });
          }

          try {
            const params = JSON.parse(apiCall.function.arguments || "{}") as unknown;
            if (!params || typeof params !== "object" || Array.isArray(params)) {
              throw new Error("工具参数必须是 JSON 对象。");
            }
            const result = await this.invokeServerTool(tool.tool, params, controller.signal);
            emit({
              requestId: request.requestId,
              type: "tool-result",
              toolCallId: apiCall.id,
              status: "completed",
              result,
            });
            messages.push({ role: "tool", content: result, tool_call_id: apiCall.id });
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            const message = error instanceof Error ? error.message : String(error);
            emit({
              requestId: request.requestId,
              type: "tool-result",
              toolCallId: apiCall.id,
              status: "error",
              error: message,
            });
            messages.push({ role: "tool", content: message, tool_call_id: apiCall.id });
          }
        }
      }
      throw new Error("工具调用超过 8 轮，已停止以避免无限循环。");
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "已停止生成"
          : error instanceof Error
            ? error.message
            : String(error);
      emit({ requestId: request.requestId, type: "error", message });
    } finally {
      this.abortControllers.delete(request.requestId);
    }
  }

  private async streamCompletion(
    request: ChatRequest,
    messages: ApiChatMessage[],
    tools: ServerTool[],
    signal: AbortSignal,
    emit: (event: ChatEvent) => void,
  ): Promise<StreamCompletionResult> {
    const effort = request.thinking ? (request.thinkingEffort ?? "medium") : "none";
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: MODEL_ALIAS,
        messages,
        stream: true,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        top_k: this.config.topK,
        top_p: this.config.topP,
        min_p: this.config.minP,
        repeat_penalty: this.config.repeatPenalty,
        presence_penalty: this.config.presencePenalty,
        reasoning_effort: effort,
        thinking_budget_tokens: request.thinking
          ? reasoningBudgetFor(request.thinkingEffort ?? "medium", this.config.maxTokens)
          : 0,
        chat_template_kwargs: {
          enable_thinking: request.thinking,
          reasoning_effort: effort,
        },
        ...(tools.length
          ? {
              tools: tools.map((tool) => tool.definition),
              tool_choice: "auto",
              parallel_tool_calls: true,
            }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`llama.cpp 返回 ${response.status}：${detail || response.statusText}`);
    }
    if (!response.body) throw new Error("llama.cpp 没有返回可读取的数据流。");

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const sse = new SseDecoder();
    const streamedCalls = new Map<number, ApiToolCall>();
    let timings: Record<string, unknown> | undefined;

    const consume = (data: string): boolean => {
      if (data === "[DONE]") return true;
      const payload = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        timings?: Record<string, unknown>;
      };
      timings = payload.timings ?? timings;
      const delta = payload.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        emit({ requestId: request.requestId, type: "reasoning", text: delta.reasoning_content });
      }
      if (delta?.content) {
        emit({ requestId: request.requestId, type: "delta", text: delta.content });
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const current = streamedCalls.get(index) ?? {
          id: fragment.id ?? `${request.requestId}-tool-${index}`,
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (fragment.id) current.id = fragment.id;
        current.function.name += fragment.function?.name ?? "";
        current.function.arguments += fragment.function?.arguments ?? "";
        streamedCalls.set(index, current);
      }
      return false;
    };

    let done = false;
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      for (const event of sse.push(textDecoder.decode(part.value, { stream: true }))) {
        done = consume(event.data);
        if (done) break;
      }
    }
    for (const event of sse.finish()) {
      if (!done) done = consume(event.data);
    }
    return { toolCalls: [...streamedCalls.values()], timings };
  }

  private async getServerTools(signal: AbortSignal): Promise<ServerTool[]> {
    if (this.toolCatalog) return this.toolCatalog;
    const response = await fetch(`${this.endpoint}/tools`, { signal });
    if (response.status === 404) {
      this.toolCatalog = [];
      return this.toolCatalog;
    }
    if (!response.ok) throw new Error(`GET /tools 返回 ${response.status}`);
    const payload = await response.json() as unknown;
    const entries = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { tools?: unknown }).tools)
        ? (payload as { tools: unknown[] }).tools
        : [];
    this.toolCatalog = entries.flatMap((entry): ServerTool[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const rawDefinition = item.definition;
      if (!rawDefinition || typeof rawDefinition !== "object" || Array.isArray(rawDefinition)) return [];
      const raw = rawDefinition as Record<string, unknown>;
      const functionValue = raw.function;
      const functionName = functionValue && typeof functionValue === "object"
        ? (functionValue as { name?: unknown }).name
        : raw.name;
      const tool = typeof item.tool === "string"
        ? item.tool
        : typeof functionName === "string"
          ? functionName
          : "";
      if (!tool) return [];
      const definition = raw.type === "function"
        ? raw
        : { type: "function", function: raw };
      const permissions = item.permissions && typeof item.permissions === "object"
        ? item.permissions as { write?: unknown }
        : {};
      return [{
        tool,
        displayName: typeof item.display_name === "string" ? item.display_name : tool,
        requiresApproval: permissions.write === true,
        definition,
        source: item.type === "mcp" ? "mcp" : "builtin",
      }];
    });
    return this.toolCatalog;
  }

  private async invokeServerTool(
    tool: string,
    params: object,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${this.endpoint}/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tool-cwd": process.cwd(),
      },
      signal,
      body: JSON.stringify({ tool, params }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`工具 ${tool} 返回 ${response.status}：${body.slice(0, 800)}`);
    let result = body;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { plain_text_response?: unknown }).plain_text_response === "string"
      ) {
        result = (parsed as { plain_text_response: string }).plain_text_response;
      } else {
        result = JSON.stringify(parsed, null, 2);
      }
    } catch {
      // Some server tool versions return plain text directly.
    }
    const limit = 64_000;
    return result.length > limit
      ? `${result.slice(0, limit)}\n\n[工具结果过长，已截断]`
      : result || "工具执行完成，没有返回内容。";
  }

  private waitForToolApproval(
    requestId: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = `${requestId}:${toolCallId}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        this.toolApprovals.delete(key);
        resolve(approved);
      };
      const abort = (): void => finish(false);
      this.toolApprovals.set(key, { resolve: finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) finish(false);
    });
  }

  private async waitUntilReady(generation: number): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = 30 * 60 * 1000;

    while (generation === this.generation && this.child && Date.now() - startedAt < timeoutMs) {
      if (await this.isHealthy(900)) {
        this.setState({
          ...this.state,
          phase: "ready",
          visionEnabled: Boolean(this.config.mmprojPath),
          pid: this.child.pid,
          endpoint: this.endpoint,
          message: "本地模型已就绪",
          error: undefined,
          download: undefined,
          externallyManaged: false,
          updatedAt: Date.now(),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (generation === this.generation && this.child) {
      this.fail("模型在 30 分钟内未能就绪，请检查网络、磁盘空间和运行日志。");
      this.child.kill();
      this.child = null;
    }
  }

  private async isHealthy(timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/health`, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(message: string): RuntimeState {
    this.setState({
      ...this.state,
      phase: "error",
      visionEnabled: false,
      endpoint: this.endpoint,
      message: "本地模型启动失败",
      error: message,
      download: undefined,
      updatedAt: Date.now(),
    });
    return this.snapshot;
  }

  private setState(state: RuntimeState): void {
    this.state = state;
    this.emit("state", this.snapshot);
  }

  private async prepareManagedModel(
    config: RuntimeConfig,
    generation: number,
    controller: AbortController,
    allowDownload: boolean,
  ): Promise<void> {
    try {
      const modelPath = await this.resolveManagedModel!(config.hfRepo, {
        signal: controller.signal,
        onProgress: (download) => this.updateDownloadState(generation, download),
        allowDownload,
      });
      if (generation !== this.generation || controller.signal.aborted) return;
      this.downloadController = null;
      if (!modelPath && !allowDownload) {
        this.setState({
          ...initialState(this.config),
          message: "模型尚未准备，请选择自动下载或导入本地 GGUF。",
          updatedAt: Date.now(),
        });
        return;
      }
      await this.launch(
        modelPath ? { ...config, modelMode: "local", modelPath } : config,
        generation,
      );
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.downloadController = null;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private updateDownloadState(
    generation: number,
    download: ModelDownloadProgress,
  ): void {
    if (generation !== this.generation) return;
    const source = download.source === "modelscope" ? "ModelScope" : "Hugging Face";
    const amount = download.totalBytes
      ? `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}`
      : formatBytes(download.receivedBytes);
    this.setState({
      ...this.state,
      phase: "downloading",
      message:
        download.percent === undefined
          ? `正在从 ${source} 下载模型`
          : `正在从 ${source} 下载模型 · ${download.percent}%`,
      lastLog: amount,
      download,
      updatedAt: Date.now(),
    });
  }

  private async launch(config: RuntimeConfig, generation: number): Promise<void> {
    let launchConfig = config;
    try {
      launchConfig = await this.prepareMcpConfig(config);
    } catch (error) {
      if (generation === this.generation) {
        this.fail(`无法准备 MCP Servers 配置：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (generation !== this.generation) {
      await this.cleanupTemporaryMcpConfigs();
      return;
    }
    const { command, args } = buildLlamaCommand(launchConfig);
    this.setState({
      phase: "starting",
      visionEnabled: false,
      endpoint: this.endpoint,
      message:
        launchConfig.modelMode === "huggingface"
          ? "正在启动 llama.cpp 并准备远程模型"
          : "正在加载本地 GGUF 模型",
      download: undefined,
      updatedAt: Date.now(),
    });

    try {
      const child = spawn(command, args, {
        cwd: isAbsolute(command) ? dirname(command) : undefined,
        env: { ...process.env },
        windowsHide: true,
        stdio: "pipe",
      });
      this.child = child;
      const handleLog = (buffer: Buffer): void => {
        const lines = buffer
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const lastLog = lines.at(-1);
        if (!lastLog) return;
        const looksLikeDownload =
          launchConfig.modelMode === "huggingface" &&
          /download|huggingface|\.gguf|%|MiB|GiB/i.test(lastLog);
        this.setState({
          ...this.state,
          phase: looksLikeDownload ? "downloading" : this.state.phase,
          message: looksLikeDownload
            ? "llama.cpp 正在下载远程 GGUF 模型"
            : this.state.message,
          lastLog: lastLog.slice(-500),
          updatedAt: Date.now(),
        });
      };

      child.stdout.on("data", handleLog);
      child.stderr.on("data", handleLog);
      child.once("error", (error) => {
        if (generation !== this.generation) return;
        this.child = null;
        void this.cleanupTemporaryMcpConfigs();
        this.fail(`无法启动 llama.cpp：${error.message}`);
      });
      child.once("exit", (code, signal) => {
        if (generation !== this.generation) return;
        this.child = null;
        void this.cleanupTemporaryMcpConfigs();
        if (this.state.phase === "stopping" || this.state.phase === "stopped") return;
        this.fail(
          `llama.cpp 已退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`}）。`,
        );
      });

      void this.waitUntilReady(generation);
    } catch (error) {
      this.child = null;
      await this.cleanupTemporaryMcpConfigs();
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async prepareMcpConfig(config: RuntimeConfig): Promise<RuntimeConfig> {
    if (!config.mcpServersConfigPath) return config;
    const contents = await fs.readFile(config.mcpServersConfigPath, "utf8");
    const prepared = prepareMcpServersConfigContents(contents);
    if (prepared === contents) return config;

    const directory = join(tmpdir(), "desk-pet-mcp");
    await fs.mkdir(directory, { recursive: true });
    const filePath = join(directory, `${process.pid}-${randomUUID()}.json`);
    await fs.writeFile(filePath, prepared, { encoding: "utf8", mode: 0o600 });
    this.temporaryMcpConfigs.add(filePath);
    return { ...config, mcpServersConfigPath: filePath };
  }

  private async cleanupTemporaryMcpConfigs(): Promise<void> {
    const paths = [...this.temporaryMcpConfigs];
    this.temporaryMcpConfigs.clear();
    await Promise.all(paths.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }));
  }
}
