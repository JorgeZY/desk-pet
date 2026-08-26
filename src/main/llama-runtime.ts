import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ChatContextUsage,
  ChatEvent,
  ChatRequest,
  ChatToolDefinition,
  ModelDownloadProgress,
  RuntimeConfig,
  RuntimeState,
  ThinkingEffort,
} from "../shared/types";
import { formatBytes, type ResolveModelOptions } from "./model-downloader";
import { thinkingBudgetFor } from "../shared/thinking-effort";
import { AgentRunner } from "./agent/agent-runner";
import { selectAgentToolsForContext } from "./agent/agent-tool-budget";
import { buildAgentModelMessages } from "./agent/chat-model-messages";
import { probeExactTokenCounter } from "./agent/exact-context-budget";
import { toChatToolDefinitions } from "./agent/llama-tool-provider";
import {
  truncateDiagnosticText,
} from "./agent/tool-result-budget";
import { ToolProviderHost } from "./agent/tool-provider-host";
import type { AgentToolDescriptor } from "./agent/tool-provider";
import { buildLlamaCommand } from "./llama-command";
export { buildLlamaCommand } from "./llama-command";

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function contextUsageFromCompletion(
  timings?: Record<string, unknown>,
  usage?: Record<string, unknown>,
): ChatContextUsage | undefined {
  const cachedPromptTokens = nonNegativeTokenCount(timings?.cache_n)
    ?? nonNegativeTokenCount(timings?.tokens_cached)
    ?? 0;
  const promptTokens = nonNegativeTokenCount(usage?.prompt_tokens)
    ?? (() => {
      const processedPromptTokens = nonNegativeTokenCount(timings?.prompt_n);
      return processedPromptTokens === undefined
        ? undefined
        : cachedPromptTokens + processedPromptTokens;
    })();
  const completionTokens = nonNegativeTokenCount(usage?.completion_tokens)
    ?? nonNegativeTokenCount(timings?.predicted_n);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: nonNegativeTokenCount(usage?.total_tokens) ?? prompt + completion,
  };
}

export function reasoningBudgetFor(effort: ThinkingEffort, maxTokens: number): number {
  return thinkingBudgetFor(effort, maxTokens);
}

export type ManagedModelResolver = (
  modelId: string,
  options: ResolveModelOptions,
) => Promise<string | null>;

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
  private readonly toolProviders: ToolProviderHost;

  constructor(
    config: RuntimeConfig,
    private readonly resolveManagedModel?: ManagedModelResolver,
  ) {
    super();
    this.config = config;
    this.state = initialState(config);
    this.toolProviders = new ToolProviderHost({
      getConfig: () => this.config,
      getEndpoint: () => this.endpoint,
      isRuntimeReady: () => this.state.phase === "ready",
      onLog: (message) => this.emitLog(message),
    });
  }

  updateConfig(config: RuntimeConfig): void {
    this.config = config;
    void this.toolProviders.close();
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
    if (
      this.state.phase === "ready"
      || this.state.phase === "starting"
      || this.state.phase === "downloading"
      || this.state.phase === "stopping"
    ) {
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

    const currentGeneration = ++this.generation;
    this.setState({
      ...this.state,
      phase: "starting",
      visionEnabled: false,
      endpoint: this.endpoint,
      message: "正在检查 llama.cpp 服务",
      error: undefined,
      updatedAt: Date.now(),
    });
    const healthy = await this.isHealthy(600);
    const phaseAfterHealth = this.snapshot.phase;
    if (currentGeneration !== this.generation || phaseAfterHealth !== "starting") {
      return this.snapshot;
    }
    if (healthy) {
      try {
        await probeExactTokenCounter(this.endpoint);
      } catch (error) {
        return this.fail(error instanceof Error ? error.message : String(error));
      }
      if (currentGeneration !== this.generation || this.snapshot.phase !== "starting") {
        return this.snapshot;
      }
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
    this.setState({
      ...this.state,
      phase: "stopping",
      visionEnabled: false,
      message: "正在停止本地模型",
      updatedAt: Date.now(),
    });
    await this.toolProviders.close();

    if (!this.child) {
      this.setState(initialState(this.config));
      return this.snapshot;
    }

    const child = this.child;
    this.child = null;

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
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const snapshot = await this.toolProviders.getSnapshot(controller.signal);
      return toChatToolDefinitions(snapshot.descriptors);
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
      let discoveredTools: AgentToolDescriptor[] = [];
      try {
        const snapshot = await this.toolProviders.getSnapshot(controller.signal);
        discoveredTools = snapshot.descriptors;
        for (const warning of snapshot.warnings) {
          emit({ requestId: request.requestId, type: "warning", message: warning });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        emit({
          requestId: request.requestId,
          type: "warning",
          message: `无法初始化工具：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!discoveredTools.some((tool) => tool.source === "builtin")) {
        emit({
          requestId: request.requestId,
          type: "warning",
          message: "当前 llama-server 未公开 builtin tools；请使用支持 --tools all 的新版服务。",
        });
      }
      const toolSelection = selectAgentToolsForContext(
        discoveredTools,
        this.config.contextSize,
      );
      const tools = toolSelection.tools;
      if (toolSelection.omitted.length) {
        const shown = toolSelection.omitted.slice(0, 8).map(({ displayName }) => displayName);
        const remaining = toolSelection.omitted.length - shown.length;
        emit({
          requestId: request.requestId,
          type: "warning",
          message: truncateDiagnosticText(
            `工具定义超过本地上下文预算，本轮启用 ${tools.length}/${discoveredTools.length} 个；`
            + `未启用：${shown.join("、")}${remaining > 0 ? `，另有 ${remaining} 个` : ""}。`
            + "请精简 MCP 配置以启用其余工具。",
          ),
        });
      }
      const messages = await buildAgentModelMessages(request.messages, {
        visionEnabled: this.state.visionEnabled,
        onWarning: (message) => emit({ requestId: request.requestId, type: "warning", message }),
      });

      const runner = new AgentRunner({
        config: this.config,
        endpoint: this.endpoint,
        tools,
        waitForApproval: (toolCallId, signal) => this.waitForToolApproval(
          request.requestId,
          toolCallId,
          signal,
        ),
      });
      await runner.run({
        request,
        messages,
        signal: controller.signal,
        emit,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "已停止生成"
          : error instanceof Error
            ? truncateDiagnosticText(error.message)
            : truncateDiagnosticText(String(error));
      emit({ requestId: request.requestId, type: "error", message });
    } finally {
      this.abortControllers.delete(request.requestId);
    }
  }

  private emitLog(message: string): void {
    this.emit("log", truncateDiagnosticText(message));
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
      const child = this.child;
      const healthy = await this.isHealthy(900);
      if (
        generation !== this.generation
        || this.child !== child
        || (this.state.phase !== "starting" && this.state.phase !== "downloading")
      ) {
        return;
      }
      if (healthy) {
        try {
          await probeExactTokenCounter(this.endpoint);
        } catch (error) {
          if (generation !== this.generation || this.child !== child) return;
          const message = error instanceof Error ? error.message : String(error);
          this.generation += 1;
          this.child = null;
          child.kill();
          this.fail(message);
          return;
        }
        if (generation !== this.generation || this.child !== child) return;
        this.setState({
          ...this.state,
          phase: "ready",
          visionEnabled: Boolean(this.config.mmprojPath),
          pid: child.pid,
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

    const child = this.child;
    if (
      generation === this.generation
      && child
      && (this.state.phase === "starting" || this.state.phase === "downloading")
    ) {
      this.fail("模型在 30 分钟内未能就绪，请检查网络、磁盘空间和运行日志。");
      child.kill();
      if (this.child === child) this.child = null;
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
    if (generation !== this.generation) return;
    const { command, args } = buildLlamaCommand(config);
    this.setState({
      phase: "starting",
      visionEnabled: false,
      endpoint: this.endpoint,
      message:
        config.modelMode === "huggingface"
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
        if (generation !== this.generation || this.child !== child) return;
        const lines = buffer
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const lastLog = lines.at(-1);
        if (!lastLog) return;
        const looksLikeDownload =
          config.modelMode === "huggingface" &&
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
        this.handleUnexpectedRuntimeExit(`无法启动 llama.cpp：${error.message}`);
      });
      child.once("exit", (code, signal) => {
        if (generation !== this.generation) return;
        this.child = null;
        if (this.state.phase === "stopping" || this.state.phase === "stopped") return;
        this.handleUnexpectedRuntimeExit(
          `llama.cpp 已退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`}）。`,
        );
      });

      void this.waitUntilReady(generation);
    } catch (error) {
      this.child = null;
      this.handleUnexpectedRuntimeExit(error instanceof Error ? error.message : String(error));
    }
  }

  private handleUnexpectedRuntimeExit(message: string): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    for (const approval of this.toolApprovals.values()) approval.resolve(false);
    this.toolApprovals.clear();
    void this.toolProviders.close();
    this.fail(message);
  }
}
