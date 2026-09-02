import { afterEach, describe, expect, it, vi } from "vitest";
import { dynamicTool, jsonSchema } from "ai";
import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import { DEFAULT_CONFIG } from "./config-store";
import type { RuntimeState } from "../shared/types";
import type { ToolProvider } from "./agent/tool-provider";
import type { AgentToolDescriptor } from "./agent/tool-provider";
import { McpToolProvider } from "./agent/mcp-tool-provider";
import {
  DIAGNOSTIC_TEXT_BYTE_LIMIT,
  utf8ByteLength,
} from "./agent/tool-result-budget";
import {
  buildLlamaCommand,
  contextUsageFromCompletion,
  LlamaRuntime,
  reasoningBudgetFor,
} from "./llama-runtime";

afterEach(() => vi.restoreAllMocks());

function stoppableChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

describe("contextUsageFromCompletion", () => {
  it("includes cached and newly processed llama.cpp prompt tokens", () => {
    expect(contextUsageFromCompletion({ cache_n: 1000, prompt_n: 234, predicted_n: 234 })).toEqual({
      promptTokens: 1234,
      completionTokens: 234,
      totalTokens: 1468,
    });
  });

  it("prefers OpenAI-compatible usage fields when present", () => {
    expect(contextUsageFromCompletion(
      { prompt_n: 1, predicted_n: 2 },
      { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
    )).toEqual({ promptTokens: 800, completionTokens: 120, totalTokens: 920 });
  });
});

describe("buildLlamaCommand", () => {
  it("uses the unified llama serve command and a replaceable HF model", () => {
    const command = buildLlamaCommand({ ...DEFAULT_CONFIG, executable: "llama" });
    expect(command.command).toBe("llama");
    expect(command.args.slice(0, 3)).toEqual([
      "serve",
      "-hf",
      "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
    ]);
    expect(command.args).toContain("--jinja");
    expect(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2))
      .toEqual(["--tools", "all"]);
    expect(command.args).toContain("desk-pet-model");
    expect(command.args).toContain("--cors-origins");
    expect(command.args).toContain("localhost");
  });

  it("does not add a subcommand to llama-server.exe", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      executable: "C:\\tools\\llama-server.exe",
      modelMode: "local",
      modelPath: "D:\\models\\any-local-model.gguf",
      mmprojPath: "D:\\models\\vision-mmproj.gguf",
    });
    expect(command.args[0]).toBe("-m");
    expect(command.args[1]).toBe("D:\\models\\any-local-model.gguf");
    expect(command.args).not.toContain("serve");
    expect(command.args).toContain("--mmproj");
    expect(command.args).toContain("D:\\models\\vision-mmproj.gguf");
  });

  it("keeps MCP configuration app-owned instead of passing it to llama.cpp", () => {
    const path = "D:\\tools\\mcp.json";
    const command = buildLlamaCommand({ ...DEFAULT_CONFIG, mcpServersConfigPath: path });
    expect(command.command).toBe("llama");
    expect(command.args[0]).toBe("serve");
    expect(command.args).not.toContain("--mcp-servers-config");
    expect(command.args).not.toContain(path);
  });

  it("does not change an absolute unified llama path when MCP is configured", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      executable: "C:\\llama.cpp\\llama.exe",
      mcpServersConfigPath: "D:\\tools\\mcp.json",
    });

    expect(command.command).toBe("C:\\llama.cpp\\llama.exe");
    expect(command.args[0]).toBe("serve");
    expect(command.args).not.toContain("--mcp-servers-config");
  });

  it("keeps medium reasoning within half of the configured output budget", () => {
    expect(reasoningBudgetFor("minimal", 512)).toBe(51);
    expect(reasoningBudgetFor("medium", 512)).toBe(256);
    expect(reasoningBudgetFor("xhigh", 512)).toBe(460);
    expect(reasoningBudgetFor("max", 512)).toBe(-1);
  });

  it("does not download an uncached remote model during automatic startup", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not running"));
    let allowDownload: boolean | undefined;
    const runtime = new LlamaRuntime(DEFAULT_CONFIG, async (_modelId, options) => {
      allowDownload = options.allowDownload;
      return null;
    });

    await runtime.start(false);
    await vi.waitFor(() => expect(runtime.snapshot.message).toContain("自动下载或导入本地 GGUF"));
    expect(allowDownload).toBe(false);
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("rejects a healthy server that lacks exact token counting", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/health")) return new Response("ok");
      return new Response("missing", { status: 404 });
    });
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);

    await expect(runtime.start()).resolves.toMatchObject({
      phase: "error",
      error: expect.stringContaining("精确 token 计数"),
    });
  });

  it("does not become ready after stop wins an in-flight health probe", async () => {
    let resolveHealth!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise<Response>((resolve) => { resolveHealth = resolve; }));
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);

    const starting = runtime.start();
    await vi.waitFor(() => expect(runtime.snapshot.phase).toBe("starting"));
    await runtime.stop();
    resolveHealth(new Response("ok"));

    expect((await starting).phase).toBe("stopped");
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("does not revive a launched child when stop wins its readiness probe", async () => {
    let resolveHealth!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise<Response>((resolve) => { resolveHealth = resolve; }));
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    const child = stoppableChild(4_301);
    const internals = runtime as unknown as {
      generation: number;
      child: typeof child | null;
      state: RuntimeState;
      waitUntilReady(generation: number): Promise<void>;
    };
    internals.generation = 1;
    internals.child = child;
    internals.state = {
      phase: "starting",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "starting",
      updatedAt: 1,
    };
    const phases: RuntimeState["phase"][] = [];
    runtime.on("state", (state: RuntimeState) => phases.push(state.phase));

    const waiting = internals.waitUntilReady(1);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await runtime.stop();
    resolveHealth(new Response("ok"));
    await waiting;

    const stoppingIndex = phases.indexOf("stopping");
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(phases.slice(stoppingIndex)).not.toContain("ready");
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("does not revive a child that exits during its readiness probe", async () => {
    let resolveHealth!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise<Response>((resolve) => { resolveHealth = resolve; }));
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    const child = stoppableChild(4_302);
    const internals = runtime as unknown as {
      generation: number;
      child: typeof child | null;
      state: RuntimeState;
      waitUntilReady(generation: number): Promise<void>;
      handleUnexpectedRuntimeExit(message: string): void;
    };
    internals.generation = 1;
    internals.child = child;
    internals.state = {
      phase: "starting",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "starting",
      updatedAt: 1,
    };

    const waiting = internals.waitUntilReady(1);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    internals.child = null;
    internals.handleUnexpectedRuntimeExit("llama exited during probe");
    resolveHealth(new Response("ok"));
    await waiting;

    expect(runtime.snapshot).toMatchObject({
      phase: "error",
      error: "llama exited during probe",
    });
    await runtime.stop();
  });

  it("stops while shared tool discovery is pending even when fetch ignores abort", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).endsWith("/health")) {
        return Promise.resolve(new Response("ok"));
      }
      if (String(input).endsWith("/v1/chat/completions/input_tokens")) {
        return Promise.resolve(Response.json({ input_tokens: 8 }));
      }
      return new Promise<Response>(() => undefined);
    });
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    await runtime.start();
    expect(runtime.snapshot.phase).toBe("ready");

    const listing = expect(runtime.listTools()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/tools"))).toBe(true);
    });

    await runtime.stop();
    await listing;
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("bounds a hanging provider close during stop", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new LlamaRuntime(DEFAULT_CONFIG);
      const provider: ToolProvider = {
        start: async () => undefined,
        getDescriptors: () => [],
        close: () => new Promise<void>(() => undefined),
      };
      const internals = runtime as unknown as {
        toolProviders: {
          snapshot: { providers: ToolProvider[]; descriptors: []; warnings: [] } | null;
        };
      };
      internals.toolProviders.snapshot = { providers: [provider], descriptors: [], warnings: [] };
      const logs: string[] = [];
      runtime.on("log", (message: string) => logs.push(message));

      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopping;

      expect(runtime.snapshot.phase).toBe("stopped");
      expect(logs.some((message) => message.includes("关闭超时"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for stale providers to close before starting replacements", async () => {
    let releaseClose!: () => void;
    const oldProvider: ToolProvider = {
      start: async () => undefined,
      getDescriptors: () => [],
      close: vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("missing", { status: 404 }));
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    const internals = runtime as unknown as {
      state: RuntimeState;
      toolProviders: {
        snapshot: { providers: ToolProvider[]; descriptors: []; warnings: [] } | null;
        getSnapshot(signal: AbortSignal): Promise<unknown>;
      };
    };
    internals.state = {
      phase: "ready",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "ready",
      updatedAt: 1,
    };
    internals.toolProviders.snapshot = {
      providers: [oldProvider],
      descriptors: [],
      warnings: [],
    };

    runtime.updateConfig({ ...DEFAULT_CONFIG, temperature: 0.3 });
    const replacement = internals.toolProviders.getSnapshot(new AbortController().signal);
    await vi.waitFor(() => expect(oldProvider.close).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();

    releaseClose();
    await replacement;
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/tools"))).toBe(true);
    await runtime.stop();
  });

  it("does not create a replacement provider once stop begins", async () => {
    let releaseClose!: () => void;
    const oldProvider: ToolProvider = {
      start: async () => undefined,
      getDescriptors: () => [],
      close: vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("missing", { status: 404 }));
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    const internals = runtime as unknown as {
      state: RuntimeState;
      toolProviders: {
        snapshot: { providers: ToolProvider[]; descriptors: []; warnings: [] } | null;
      };
    };
    internals.state = {
      phase: "ready",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "ready",
      updatedAt: 1,
    };
    internals.toolProviders.snapshot = {
      providers: [oldProvider],
      descriptors: [],
      warnings: [],
    };

    runtime.updateConfig({ ...DEFAULT_CONFIG, temperature: 0.3 });
    const listing = runtime.listTools();
    const stopping = runtime.stop();
    expect(runtime.snapshot.phase).toBe("stopping");
    expect((await runtime.start()).phase).toBe("stopping");
    await vi.waitFor(() => expect(oldProvider.close).toHaveBeenCalledTimes(1));

    releaseClose();
    await expect(listing).rejects.toThrow("本地模型正在停止");
    await stopping;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.snapshot.phase).toBe("stopped");
  });

  it("closes active tool providers after an unexpected llama exit", async () => {
    const provider: ToolProvider = {
      start: async () => undefined,
      getDescriptors: () => [],
      close: vi.fn(async () => undefined),
    };
    const runtime = new LlamaRuntime(DEFAULT_CONFIG);
    const internals = runtime as unknown as {
      abortControllers: Map<string, AbortController>;
      toolApprovals: Map<string, { resolve: (approved: boolean) => void }>;
      toolProviders: {
        snapshot: { providers: ToolProvider[]; descriptors: []; warnings: [] } | null;
      };
      handleUnexpectedRuntimeExit(message: string): void;
    };
    internals.toolProviders.snapshot = {
      providers: [provider],
      descriptors: [],
      warnings: [],
    };
    const chatController = new AbortController();
    const resolveApproval = vi.fn();
    internals.abortControllers.set("request-1", chatController);
    internals.toolApprovals.set("request-1:call-1", { resolve: resolveApproval });

    internals.handleUnexpectedRuntimeExit("llama exited");
    await vi.waitFor(() => expect(provider.close).toHaveBeenCalledTimes(1));
    expect(chatController.signal.aborted).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith(false);
    expect(internals.abortControllers.size).toBe(0);
    expect(internals.toolApprovals.size).toBe(0);
    expect(runtime.snapshot).toMatchObject({ phase: "error", error: "llama exited" });
    await runtime.stop();
  });

  it("surfaces an isolated MCP startup failure while retaining healthy tools", async () => {
    vi.spyOn(fs, "readFile").mockResolvedValue('{"mcpServers":{"broken":{"command":"broken"},"healthy":{"command":"healthy"}}}');
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }));
    const healthyDescriptor: AgentToolDescriptor = {
      name: "mcp__healthy__ping",
      displayName: "healthy · ping",
      source: "mcp",
      requiresApproval: true,
      tool: dynamicTool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => "pong",
      }),
    };
    const mcpProvider: ToolProvider = {
      start: async () => undefined,
      getDescriptors: () => [healthyDescriptor],
      close: async () => undefined,
    };
    vi.spyOn(McpToolProvider, "fromConfigContents").mockImplementation((_contents, options) => {
      options.onServerStartError?.("broken", new Error(`spawn failed: ${"坏".repeat(100_000)}`));
      return mcpProvider as McpToolProvider;
    });

    const runtime = new LlamaRuntime({
      ...DEFAULT_CONFIG,
      mcpServersConfigPath: "D:\\tools\\mcp.json",
    });
    const internals = runtime as unknown as {
      state: RuntimeState;
      toolProviders: {
        getSnapshot(signal: AbortSignal): Promise<{
          descriptors: AgentToolDescriptor[];
          warnings: string[];
        }>;
      };
    };
    internals.state = {
      phase: "ready",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "ready",
      updatedAt: 1,
    };
    const snapshot = await internals.toolProviders.getSnapshot(new AbortController().signal);

    expect(snapshot.descriptors.map(({ name }) => name)).toContain("mcp__healthy__ping");
    const warning = snapshot.warnings.find((message) => message.includes("spawn failed"));
    expect(warning).toContain("[诊断信息过长，已截断]");
    expect(utf8ByteLength(warning ?? "")).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_BYTE_LIMIT);
    await runtime.stop();
  });

  it("uses safe defaults for required disabled parameters and omits optional tuning flags", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      port: 29999,
      contextSize: 32768,
      gpuLayers: 12,
      threads: 3,
      modelParameterOverrides: {
        ...DEFAULT_CONFIG.modelParameterOverrides,
        port: false,
        contextSize: false,
        gpuLayers: false,
        threads: false,
      },
    });

    expect(command.args.slice(command.args.indexOf("--port"), command.args.indexOf("--port") + 2))
      .toEqual(["--port", "18766"]);
    expect(command.args.slice(command.args.indexOf("-c"), command.args.indexOf("-c") + 2))
      .toEqual(["-c", "8192"]);
    expect(command.args).not.toContain("-ngl");
    expect(command.args).not.toContain("-t");
  });

  it("does not initialize disabled tool sources", async () => {
    const readFile = vi.spyOn(fs, "readFile");
    const runtime = new LlamaRuntime({
      ...DEFAULT_CONFIG,
      mcpServersConfigPath: "D:\\tools\\mcp.json",
      toolSettings: {
        builtinEnabled: false,
        mcpEnabled: false,
        disabledToolIds: [],
      },
    });
    const internals = runtime as unknown as {
      state: RuntimeState;
      toolProviders: {
        getSnapshot(signal: AbortSignal): Promise<{ descriptors: AgentToolDescriptor[] }>;
      };
    };
    internals.state = {
      phase: "ready",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "ready",
      updatedAt: 1,
    };

    const snapshot = await internals.toolProviders.getSnapshot(new AbortController().signal);

    expect(snapshot.descriptors).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
