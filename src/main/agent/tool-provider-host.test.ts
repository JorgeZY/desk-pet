import { promises as fs } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, RuntimeState } from "../../shared/types";
import { DEFAULT_CONFIG } from "../config-store";
import { LlamaRuntime } from "../llama-runtime";
import { ToolProviderHost } from "./tool-provider-host";

type HarnessSource = "builtin" | "mcp" | "knowledge" | "task";

const providerHarness = vi.hoisted(() => {
  const toolNames: Record<HarnessSource, string> = {
    builtin: "builtin-tool",
    mcp: "mcp-tool",
    knowledge: "search_local_knowledge",
    task: "create_long_task",
  };
  const instances: Record<HarnessSource, Array<{
    start: ReturnType<typeof vi.fn>;
    getDescriptors: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>> = {
    builtin: [],
    mcp: [],
    knowledge: [],
    task: [],
  };
  const mcpConfigContents: string[] = [];

  const create = (source: HarnessSource) => {
    const descriptor = {
      name: toolNames[source],
      displayName: `${source} tool`,
      source,
      requiresApproval: false,
      tool: {},
    };
    const instance = {
      start: vi.fn(async () => undefined),
      getDescriptors: vi.fn(() => [descriptor]),
      close: vi.fn(async () => undefined),
    };
    instances[source].push(instance);
    return instance;
  };

  const reset = () => {
    for (const source of Object.keys(instances) as HarnessSource[]) {
      instances[source].splice(0);
    }
    mcpConfigContents.splice(0);
  };

  return { create, instances, mcpConfigContents, reset, toolNames };
});

vi.mock("./llama-tool-provider", () => ({
  LlamaToolProvider: class MockLlamaToolProvider {
    private readonly delegate = providerHarness.create("builtin");

    start(signal?: AbortSignal) {
      return this.delegate.start(signal);
    }

    getDescriptors() {
      return this.delegate.getDescriptors();
    }

    close() {
      return this.delegate.close();
    }
  },
  toChatToolDefinitions: (descriptors: Array<{
    name: string;
    displayName: string;
    source: HarnessSource;
    requiresApproval: boolean;
  }>) => descriptors.map((descriptor) => ({
    id: descriptor.name,
    displayName: descriptor.displayName,
    source: descriptor.source,
    requiresApproval: descriptor.requiresApproval,
  })),
}));

vi.mock("./mcp-tool-provider", () => {
  class MockMcpToolProvider {
    private readonly delegate = providerHarness.create("mcp");

    static fromConfigContents(contents: string) {
      providerHarness.mcpConfigContents.push(contents);
      return new MockMcpToolProvider();
    }

    start(signal?: AbortSignal) {
      return this.delegate.start(signal);
    }

    getDescriptors() {
      return this.delegate.getDescriptors();
    }

    close() {
      return this.delegate.close();
    }
  }
  return { McpToolProvider: MockMcpToolProvider };
});

vi.mock("./knowledge-tool-provider", () => ({
  KnowledgeToolProvider: class MockKnowledgeToolProvider {
    private readonly delegate = providerHarness.create("knowledge");

    start(signal?: AbortSignal) {
      return this.delegate.start(signal);
    }

    getDescriptors() {
      return this.delegate.getDescriptors();
    }

    close() {
      return this.delegate.close();
    }
  },
}));

vi.mock("./long-task-tool-provider", () => ({
  LongTaskToolProvider: class MockLongTaskToolProvider {
    private readonly delegate = providerHarness.create("task");

    start(signal?: AbortSignal) {
      return this.delegate.start(signal);
    }

    getDescriptors() {
      return this.delegate.getDescriptors();
    }

    close() {
      return this.delegate.close();
    }
  },
}));

function runtimeConfig(toolSettings: Partial<RuntimeConfig["toolSettings"]> = {}): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    mcpServersConfigPath: "D:\\tools\\mcp.json",
    toolSettings: {
      builtinEnabled: true,
      mcpEnabled: true,
      knowledgeEnabled: true,
      tasksEnabled: true,
      disabledToolIds: [],
      ...toolSettings,
    },
  };
}

function createHost(configRef: { current: RuntimeConfig }) {
  return new ToolProviderHost({
    getConfig: () => configRef.current,
    getEndpoint: () => "http://127.0.0.1:18766",
    isRuntimeReady: () => true,
    onLog: vi.fn(),
    knowledgeRetriever: {} as never,
    longTaskStore: {} as never,
  });
}

const sourceSwitches: Array<[
  HarnessSource,
  keyof Pick<
    RuntimeConfig["toolSettings"],
    "builtinEnabled" | "mcpEnabled" | "knowledgeEnabled" | "tasksEnabled"
  >,
]> = [
  ["builtin", "builtinEnabled"],
  ["mcp", "mcpEnabled"],
  ["knowledge", "knowledgeEnabled"],
  ["task", "tasksEnabled"],
];

beforeEach(() => {
  providerHarness.reset();
  vi.spyOn(fs, "readFile").mockResolvedValue("{\"mcpServers\":{}}" as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolProviderHost", () => {
  it.each(sourceSwitches)(
    "does not construct or start the %s provider when its switch is disabled",
    async (disabledSource, switchName) => {
      const configRef = {
        current: runtimeConfig({ [switchName]: false }),
      };
      const host = createHost(configRef);

      const snapshot = await host.getSnapshot(new AbortController().signal);

      expect(providerHarness.instances[disabledSource]).toHaveLength(0);
      expect(snapshot.descriptors.some((descriptor) => descriptor.source === disabledSource))
        .toBe(false);
      for (const source of sourceSwitches.map(([candidate]) => candidate)) {
        if (source === disabledSource) continue;
        expect(providerHarness.instances[source]).toHaveLength(1);
        expect(providerHarness.instances[source][0]!.start).toHaveBeenCalledOnce();
      }
      if (disabledSource === "mcp") {
        expect(fs.readFile).not.toHaveBeenCalled();
        expect(providerHarness.mcpConfigContents).toEqual([]);
      }
      await host.close();
    },
  );

  it("filters one disabled tool without preventing its provider from starting", async () => {
    const configRef = {
      current: runtimeConfig({ disabledToolIds: [providerHarness.toolNames.mcp] }),
    };
    const host = createHost(configRef);

    const snapshot = await host.getSnapshot(new AbortController().signal);

    expect(snapshot.providers).toHaveLength(4);
    expect(snapshot.descriptors.map((descriptor) => descriptor.name)).toEqual([
      providerHarness.toolNames.task,
      providerHarness.toolNames.knowledge,
      providerHarness.toolNames.builtin,
    ]);
    expect(providerHarness.instances.mcp).toHaveLength(1);
    expect(providerHarness.instances.mcp[0]!.start).toHaveBeenCalledOnce();
    await host.close();
  });

  it("closes the old provider snapshot before rebuilding from updated config", async () => {
    const configRef = { current: runtimeConfig() };
    const host = createHost(configRef);
    await host.getSnapshot(new AbortController().signal);
    const oldInstances = Object.fromEntries(
      sourceSwitches.map(([source]) => [source, providerHarness.instances[source][0]!]),
    ) as Record<HarnessSource, (typeof providerHarness.instances)[HarnessSource][number]>;

    configRef.current = runtimeConfig({
      builtinEnabled: false,
      mcpEnabled: false,
      knowledgeEnabled: false,
      tasksEnabled: false,
    });
    await host.close();
    const rebuilt = await host.getSnapshot(new AbortController().signal);

    for (const source of sourceSwitches.map(([candidate]) => candidate)) {
      expect(oldInstances[source].close).toHaveBeenCalledOnce();
      expect(providerHarness.instances[source]).toHaveLength(1);
    }
    expect(rebuilt.providers).toEqual([]);
    expect(rebuilt.descriptors).toEqual([]);
  });

  it("LlamaRuntime config updates and restart close the active providers", async () => {
    const config = runtimeConfig({
      mcpEnabled: false,
      knowledgeEnabled: false,
      tasksEnabled: false,
    });
    const runtime = new LlamaRuntime(config);
    const internals = runtime as unknown as { state: RuntimeState };
    internals.state = {
      phase: "ready",
      visionEnabled: false,
      endpoint: runtime.endpoint,
      message: "ready",
      updatedAt: 1,
    };

    await runtime.listTools();
    const firstProvider = providerHarness.instances.builtin[0]!;
    runtime.updateConfig({
      ...config,
      toolSettings: { ...config.toolSettings, disabledToolIds: ["builtin-tool"] },
    });
    await runtime.listTools();

    expect(firstProvider.close).toHaveBeenCalledOnce();
    expect(providerHarness.instances.builtin).toHaveLength(2);
    const secondProvider = providerHarness.instances.builtin[1]!;
    const start = vi.spyOn(runtime, "start").mockResolvedValue(runtime.snapshot);

    await runtime.restart();

    expect(secondProvider.close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});
