import { promises as fs } from "node:fs";
import type { RuntimeConfig } from "../../shared/types";
import { LlamaToolProvider } from "./llama-tool-provider";
import { McpToolProvider } from "./mcp-tool-provider";
import { truncateDiagnosticText } from "./tool-result-budget";
import {
  mergeToolDescriptors,
  type AgentToolDescriptor,
  type ToolProvider,
} from "./tool-provider";

const BUILTIN_START_TIMEOUT_MS = 7_000;
const MCP_START_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 3_000;

export interface ToolProviderSnapshot {
  providers: ToolProvider[];
  descriptors: AgentToolDescriptor[];
  warnings: string[];
}

interface DetachedProviders {
  active: ToolProvider[];
  pending: Promise<ToolProviderSnapshot> | null;
}

export interface ToolProviderHostOptions {
  getConfig: () => RuntimeConfig;
  getEndpoint: () => string;
  isRuntimeReady: () => boolean;
  onLog: (message: string) => void;
}

/** Owns discovery, replacement, and bounded shutdown of app-owned tools. */
export class ToolProviderHost {
  private snapshot: ToolProviderSnapshot | null = null;
  private pending: Promise<ToolProviderSnapshot> | null = null;
  private controller: AbortController | null = null;
  private revision = 0;
  private closeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ToolProviderHostOptions) {}

  async getSnapshot(signal: AbortSignal): Promise<ToolProviderSnapshot> {
    let closeTail: Promise<void>;
    do {
      closeTail = this.closeTail;
      await awaitWithAbort(closeTail, signal);
    } while (closeTail !== this.closeTail);
    if (!this.options.isRuntimeReady()) {
      throw new Error("本地模型正在停止，无法初始化工具。");
    }
    if (this.snapshot) return this.snapshot;
    if (!this.pending) {
      const revision = this.revision;
      const controller = new AbortController();
      this.controller = controller;
      this.pending = this.initialize(controller.signal)
        .then(async (snapshot) => {
          if (revision !== this.revision) {
            await closeProviders(snapshot.providers, this.options.onLog);
            throw new DOMException("Tool providers changed", "AbortError");
          }
          this.snapshot = snapshot;
          return snapshot;
        })
        .finally(() => {
          if (revision === this.revision) {
            this.pending = null;
            this.controller = null;
          }
        });
    }
    return awaitWithAbort(this.pending, signal);
  }

  close(): Promise<void> {
    const detached = this.detach();
    const closing = this.closeTail.then(() => this.closeDetached(detached));
    this.closeTail = closing.catch((error) => {
      this.options.onLog(error instanceof Error ? error.message : String(error));
    });
    return this.closeTail;
  }

  private async initialize(signal: AbortSignal): Promise<ToolProviderSnapshot> {
    const config = this.options.getConfig();
    const providers: ToolProvider[] = [];
    const warnings: string[] = [];
    const candidates: Array<{ label: string; provider: ToolProvider; timeoutMs: number }> = [{
      label: "llama-server builtin tools",
      provider: new LlamaToolProvider({ endpoint: this.options.getEndpoint(), cwd: process.cwd() }),
      timeoutMs: BUILTIN_START_TIMEOUT_MS,
    }];

    if (config.mcpServersConfigPath) {
      try {
        const contents = await fs.readFile(config.mcpServersConfigPath, "utf8");
        candidates.push({
          label: "MCP Servers",
          provider: McpToolProvider.fromConfigContents(contents, {
            onServerStartError: (serverName, error) => {
              const detail = error instanceof Error ? error.message : String(error);
              const warning = truncateDiagnosticText(
                `MCP server「${serverName}」初始化失败，已跳过：${detail}`,
              );
              if (!warnings.includes(warning)) warnings.push(warning);
              this.options.onLog(`[mcp:${serverName}] ${detail}`);
            },
            onUncaughtError: (serverName, error) => {
              this.options.onLog(
                `[mcp:${serverName}] ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          }),
          timeoutMs: MCP_START_TIMEOUT_MS,
        });
      } catch (error) {
        warnings.push(`无法读取 MCP Servers 配置：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      for (const candidate of candidates) {
        signal.throwIfAborted();
        try {
          await startProviderWithin(candidate.provider, signal, candidate.timeoutMs);
          providers.push(candidate.provider);
        } catch (error) {
          await closeProviders(
            [candidate.provider],
            (message) => this.options.onLog(`[${candidate.label}] ${message}`),
          );
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          warnings.push(truncateDiagnosticText(
            `${candidate.label} 初始化失败：${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      }
      return {
        providers,
        descriptors: mergeToolDescriptors(providers.map((provider) => provider.getDescriptors())),
        warnings,
      };
    } catch (error) {
      await closeProviders(providers, this.options.onLog);
      throw error;
    }
  }

  private detach(): DetachedProviders {
    this.revision += 1;
    this.controller?.abort();
    this.controller = null;
    const active = [...(this.snapshot?.providers ?? [])];
    this.snapshot = null;
    const pending = this.pending;
    this.pending = null;
    return { active, pending };
  }

  private async closeDetached(detached: DetachedProviders): Promise<void> {
    const { active, pending } = detached;
    if (pending) {
      try {
        const snapshot = await settleWithin(
          pending,
          CLOSE_TIMEOUT_MS,
          "等待工具提供器初始化停止超时",
        );
        active.push(...snapshot.providers.filter((provider) => !active.includes(provider)));
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          this.options.onLog(error instanceof Error ? error.message : String(error));
        }
      }
    }
    await closeProviders(active, this.options.onLog);
  }
}

async function startProviderWithin(
  provider: ToolProvider,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", forwardAbort, { once: true });
  if (parentSignal.aborted) forwardAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Tool provider start timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    await awaitWithAbort(provider.start(controller.signal), controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`初始化超时（${timeoutMs} ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", forwardAbort);
  }
}

async function closeProviders(
  providers: ToolProvider[],
  onWarning: (message: string) => void,
): Promise<void> {
  for (const provider of [...providers].reverse()) {
    try {
      await settleWithin(
        provider.close(),
        CLOSE_TIMEOUT_MS,
        `${provider.constructor.name || "ToolProvider"} 关闭超时，已继续停止流程`,
      );
    } catch (error) {
      onWarning(error instanceof Error ? error.message : String(error));
    }
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${message}（${timeoutMs} ms）`));
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
