import { dynamicTool, jsonSchema } from "ai";
import type { ChatToolDefinition } from "../../shared/types";
import type { AgentToolDescriptor, ToolProvider } from "./tool-provider";

const TOOL_RESULT_LIMIT = 64_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

interface LlamaServerToolEntry {
  tool: string;
  displayName: string;
  requiresApproval: boolean;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface LlamaToolProviderOptions {
  endpoint: string;
  cwd?: string;
  fetch?: typeof fetch;
  discoveryTimeoutMs?: number;
}

/** Provides llama.cpp builtin tools while MCP tools are owned by the app. */
export class LlamaToolProvider implements ToolProvider {
  private readonly endpoint: string;
  private readonly cwd: string;
  private readonly fetch: typeof fetch;
  private readonly discoveryTimeoutMs: number;
  private descriptors: AgentToolDescriptor[] = [];
  private started = false;

  constructor(options: LlamaToolProviderOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.cwd = options.cwd ?? process.cwd();
    this.fetch = options.fetch ?? globalThis.fetch;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.started) return;
    const controller = new AbortController();
    let discoveryTimedOut = false;
    const forwardAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const timeout = setTimeout(() => {
      discoveryTimedOut = true;
      controller.abort(new DOMException("Tool discovery timed out", "TimeoutError"));
    }, this.discoveryTimeoutMs);

    try {
      const response = await awaitWithSignal(
        this.fetch(`${this.endpoint}/tools`, { signal: controller.signal }),
        controller.signal,
      );
      if (response.status === 404) {
        this.descriptors = [];
        this.started = true;
        return;
      }
      if (!response.ok) throw new Error(`GET /tools 返回 ${response.status}`);

      const payload = await awaitWithSignal(response.json(), controller.signal);
      const entries = parseServerTools(payload);
      this.descriptors = entries.map((entry) => ({
        name: entry.tool,
        displayName: entry.displayName,
        source: "builtin" as const,
        requiresApproval: entry.requiresApproval,
        metadata: { originalName: entry.tool },
        tool: dynamicTool({
          title: entry.displayName,
          description: entry.description ?? entry.displayName,
          inputSchema: jsonSchema(entry.parameters),
          execute: async (input, options) => this.invoke(entry.tool, input, options.abortSignal),
        }),
      }));
      this.started = true;
    } catch (error) {
      if (discoveryTimedOut && !signal?.aborted) {
        throw new Error(`GET /tools 在 ${this.discoveryTimeoutMs} ms 内未响应`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  getDescriptors(): readonly AgentToolDescriptor[] {
    return [...this.descriptors];
  }

  async close(): Promise<void> {
    this.descriptors = [];
    this.started = false;
  }

  private async invoke(tool: string, input: unknown, signal?: AbortSignal): Promise<string> {
    const params = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const response = await this.fetch(`${this.endpoint}/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tool-cwd": this.cwd,
      },
      signal,
      body: JSON.stringify({ tool, params }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`工具 ${tool} 返回 ${response.status}：${body.slice(0, 800)}`);
    }

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
      // Older llama.cpp builds return plain text directly.
    }

    return result.length > TOOL_RESULT_LIMIT
      ? `${result.slice(0, TOOL_RESULT_LIMIT)}\n\n[工具结果过长，已截断]`
      : result || "工具执行完成，没有返回内容。";
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function parseServerTools(payload: unknown): LlamaServerToolEntry[] {
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { tools?: unknown }).tools)
      ? (payload as { tools: unknown[] }).tools
      : [];

  return entries.flatMap((entry): LlamaServerToolEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    // MCP tools are connected directly through @ai-sdk/mcp and must not be duplicated.
    if (item.type === "mcp") return [];
    const definition = item.definition;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
    const raw = definition as Record<string, unknown>;
    const functionValue = raw.type === "function" ? raw.function : raw;
    if (!functionValue || typeof functionValue !== "object" || Array.isArray(functionValue)) return [];
    const functionDefinition = functionValue as Record<string, unknown>;
    const tool = typeof item.tool === "string"
      ? item.tool
      : typeof functionDefinition.name === "string"
        ? functionDefinition.name
        : "";
    if (!tool) return [];
    const permissions = item.permissions && typeof item.permissions === "object"
      ? item.permissions as { write?: unknown }
      : {};
    const parameters = functionDefinition.parameters;
    return [{
      tool,
      displayName: typeof item.display_name === "string" ? item.display_name : tool,
      // /tools is an internal llama.cpp surface whose metadata may drift.
      // Only an explicit read-only declaration is safe to execute silently.
      requiresApproval: permissions.write !== false,
      description: typeof functionDefinition.description === "string"
        ? functionDefinition.description
        : undefined,
      parameters: parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? parameters as Record<string, unknown>
        : { type: "object", properties: {} },
    }];
  });
}

export function toChatToolDefinitions(
  descriptors: readonly AgentToolDescriptor[],
): ChatToolDefinition[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.name,
    displayName: descriptor.displayName,
    source: descriptor.source,
    requiresApproval: descriptor.requiresApproval,
  }));
}
