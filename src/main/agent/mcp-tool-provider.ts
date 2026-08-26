import { createHash } from "node:crypto";
import {
  createMCPClient,
  type ListToolsResult,
  type MCPClient,
  type MCPClientConfig,
  type MCPTransport,
} from "@ai-sdk/mcp";
import {
  parseMcpServersConfigContents,
  type McpHttpServerConfig,
  type McpStdioServerConfig,
  type ParsedMcpServerConfig,
  type ParsedMcpServersDocument,
} from "../mcp-servers-config";
import { withWindowsStdioProcessTreeCleanup } from "./stdio-process-tree-transport";
import type { AgentToolDescriptor, ToolProvider } from "./tool-provider";

const TOOL_NAME_LIMIT = 64;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MIN_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TOOL_DISCOVERY_PAGES = 100;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOL_DEFINITION_BYTES = 1024 * 1024;

type McpToolDefinition = ListToolsResult["tools"][number];

export interface McpToolProviderOptions {
  config: ParsedMcpServersDocument;
  clientName?: string;
  clientVersion?: string;
  initializationTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Receives an isolated server initialization/discovery failure exactly once. */
  onServerStartError?: (serverName: string, error: unknown) => void;
  /** Receives asynchronous errors after a client has initialized successfully. */
  onUncaughtError?: (serverName: string, error: unknown) => void;
}

export interface McpToolProviderDependencies {
  createClient?: (config: MCPClientConfig) => Promise<MCPClient>;
  createStdioTransport?: (config: McpStdioTransportConfig) => MCPTransport;
  processEnv?: NodeJS.ProcessEnv;
}

interface OpenClient {
  serverName: string;
  client: MCPClient;
}

interface InitializedServer extends OpenClient {
  descriptors: AgentToolDescriptor[];
}

type ProviderState = "idle" | "starting" | "started" | "closed";

/** Narrow copy of the public @ai-sdk/mcp/mcp-stdio constructor input. */
export interface McpStdioTransportConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: "pipe" | "inherit" | "ignore";
}

/**
 * App-owned MCP provider. It keeps transport lifecycle and MCP naming out of
 * the agent runner while returning ordinary AI SDK tools for execution.
 */
export class McpToolProvider implements ToolProvider {
  private readonly config: ParsedMcpServersDocument;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly initializationTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly onServerStartError?: (serverName: string, error: unknown) => void;
  private readonly onUncaughtError?: (serverName: string, error: unknown) => void;
  private readonly createClient: (config: MCPClientConfig) => Promise<MCPClient>;
  private readonly createStdioTransport: (config: McpStdioTransportConfig) => MCPTransport;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly lifetimeController = new AbortController();
  private readonly clients: OpenClient[] = [];
  private descriptors: AgentToolDescriptor[] = [];
  private state: ProviderState = "idle";
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(
    options: McpToolProviderOptions,
    dependencies: McpToolProviderDependencies = {},
  ) {
    this.config = options.config;
    this.clientName = options.clientName ?? "desk-pet";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 15_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    if (
      !Number.isFinite(this.closeTimeoutMs)
      || this.closeTimeoutMs < MIN_CLOSE_TIMEOUT_MS
      || this.closeTimeoutMs > MAX_CLOSE_TIMEOUT_MS
    ) {
      throw new Error("MCP close timeout must be between 2000 and 5000 milliseconds.");
    }
    this.onServerStartError = options.onServerStartError;
    this.onUncaughtError = options.onUncaughtError;
    this.createClient = dependencies.createClient ?? createMCPClient;
    this.createStdioTransport = dependencies.createStdioTransport
      ?? createDefaultStdioTransport;
    this.processEnv = dependencies.processEnv ?? process.env;
  }

  static fromConfigContents(
    contents: string,
    options: Omit<McpToolProviderOptions, "config"> = {},
    dependencies: McpToolProviderDependencies = {},
  ): McpToolProvider {
    return new McpToolProvider(
      { ...options, config: parseMcpServersConfigContents(contents) },
      dependencies,
    );
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.state === "closed") {
      return Promise.reject(new Error("MCP tool provider is closed."));
    }
    if (this.state === "started") return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.state = "starting";
    this.startPromise = this.startInternal(signal)
      .then(() => {
        if (this.state !== "closed") this.state = "started";
      })
      .catch(async (error: unknown) => {
        const closeErrors = await this.closeClients();
        this.descriptors = [];
        if (this.state !== "closed") this.state = "idle";
        this.startPromise = undefined;
        if (closeErrors.length) {
          throw new AggregateError(
            [error, ...closeErrors],
            "Failed to start MCP tool provider and clean up clients.",
          );
        }
        throw error;
      });
    return this.startPromise;
  }

  getDescriptors(): readonly AgentToolDescriptor[] {
    return [...this.descriptors];
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.state = "closed";
    this.lifetimeController.abort(new Error("MCP tool provider closed."));

    try {
      await this.startPromise;
    } catch {
      // start() already closed every client it managed to create.
    }

    const closeErrors = await this.closeClients();
    this.descriptors = [];
    if (closeErrors.length) {
      throw new AggregateError(closeErrors, "Failed to close one or more MCP clients.");
    }
  }

  private async startInternal(signal?: AbortSignal): Promise<void> {
    const initializationSignal = signal
      ? AbortSignal.any([signal, this.lifetimeController.signal])
      : this.lifetimeController.signal;
    const descriptors: AgentToolDescriptor[] = [];
    const names = new Map<string, { serverName: string; originalName: string }>();
    const failures: Array<{ serverName: string; error: unknown }> = [];

    for (const [serverName, serverConfig] of Object.entries(this.config.mcpServers)) {
      initializationSignal.throwIfAborted();
      try {
        const initialized = await this.initializeServer(
          serverName,
          serverConfig,
          initializationSignal,
          names,
        );
        this.clients.push({ serverName, client: initialized.client });
        descriptors.push(...initialized.descriptors);
        for (const descriptor of initialized.descriptors) {
          names.set(descriptor.name, {
            serverName,
            originalName: String(descriptor.metadata?.originalName ?? descriptor.name),
          });
        }
      } catch (error) {
        if (initializationSignal.aborted) throw error;
        failures.push({ serverName, error });
        this.reportServerStartError(serverName, error);
      }
    }

    if (!this.clients.length) {
      const failureSummary = failures.map(({ serverName, error }) =>
        `"${serverName}": ${error instanceof Error ? error.message : String(error)}`
      ).join("; ");
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Failed to initialize every configured MCP server: ${failureSummary || "unknown"}.`,
      );
    }
    this.descriptors = descriptors;
  }

  private async initializeServer(
    serverName: string,
    config: ParsedMcpServerConfig,
    signal: AbortSignal,
    names: ReadonlyMap<string, { serverName: string; originalName: string }>,
  ): Promise<InitializedServer> {
    let client: MCPClient | undefined;
    try {
      const initialized = await this.createServerClient(serverName, config, signal);
      client = initialized.client;
      const definitions = await listAllTools(
        client,
        signal,
        this.initializationTimeoutMs,
      );
      const tools = client.toolsFromDefinitions({ tools: definitions });
      const descriptors: AgentToolDescriptor[] = [];
      const serverNames = new Map<string, string>();

      for (const definition of definitions) {
        const tool = tools[definition.name];
        if (!tool) continue;
        const name = createMcpAgentToolName(serverName, definition.name);
        const existing = names.get(name);
        const sameServerName = serverNames.get(name);
        if (existing || sameServerName) {
          const existingServer = existing?.serverName ?? serverName;
          const existingTool = existing?.originalName ?? sameServerName!;
          throw new Error(
            `MCP tool name collision: "${name}" represents both `
            + `"${existingServer}/${existingTool}" and `
            + `"${serverName}/${definition.name}".`,
          );
        }
        serverNames.set(name, definition.name);

        const approval = classifyMcpToolApproval(definition);
        const title = definition.title ?? definition.annotations?.title ?? definition.name;
        descriptors.push({
          name,
          displayName: `${serverName} · ${title}`,
          source: "mcp",
          requiresApproval: approval.requiresApproval,
          tool,
          metadata: {
            serverName,
            originalName: definition.name,
            transport: initialized.transport,
            configuredTransport: config.transport,
            approvalReason: approval.reason,
            readOnlyHint: approval.readOnlyHint,
            destructiveHint: approval.destructiveHint,
          },
        });
      }
      return { serverName, client, descriptors };
    } catch (error) {
      if (!client) throw error;
      const closeError = await this.closeClient({ serverName, client });
      if (!closeError) throw error;
      throw new AggregateError(
        [error, closeError],
        `MCP server "${serverName}" failed and could not close cleanly.`,
      );
    }
  }

  private async createServerClient(
    serverName: string,
    config: ParsedMcpServerConfig,
    signal: AbortSignal,
  ): Promise<{ client: MCPClient; transport: "stdio" | "http" | "sse" }> {
    if (config.transport === "stdio") {
      return {
        client: await this.createConfiguredClient(
          serverName,
          this.createStdioTransport(normalizeStdioConfig(config, this.processEnv)),
          signal,
        ),
        transport: "stdio",
      };
    }

    const headers = resolveHttpHeaders(serverName, config, this.processEnv);
    const connect = async (transport: "http" | "sse"): Promise<MCPClient> =>
      this.createConfiguredClient(serverName, {
        type: transport,
        url: config.url,
        headers,
        // Do not forward configured credentials across redirects.
        redirect: "error",
      }, signal);

    if (config.transport !== "auto") {
      return { client: await connect(config.transport), transport: config.transport };
    }
    try {
      return { client: await connect("http"), transport: "http" };
    } catch (error) {
      if (signal.aborted || !isHttpTransportIncompatibility(error)) throw error;
      return { client: await connect("sse"), transport: "sse" };
    }
  }

  private async createConfiguredClient(
    serverName: string,
    transport: MCPClientConfig["transport"],
    signal: AbortSignal,
  ): Promise<MCPClient> {
    let initialized = false;
    const client = await this.createClient({
      transport,
      clientName: `${this.clientName}:${serverName}`,
      version: this.clientVersion,
      initializationOptions: {
        signal,
        timeout: this.initializationTimeoutMs,
      },
      maxRetries: 0,
      // Initialization failures are reported once by the per-server boundary.
      // This also prevents a successful HTTP -> SSE compatibility fallback
      // from surfacing a misleading warning for the discarded HTTP probe.
      onUncaughtError: (error) => {
        if (initialized) this.reportServerError(serverName, error);
      },
    });
    initialized = true;
    return client;
  }

  private reportServerError(serverName: string, error: unknown): void {
    try {
      this.onUncaughtError?.(serverName, error);
    } catch {
      // Observability callbacks must not change MCP lifecycle behavior.
    }
  }

  private reportServerStartError(serverName: string, error: unknown): void {
    try {
      this.onServerStartError?.(serverName, error);
    } catch {
      // Observability callbacks must not change MCP lifecycle behavior.
    }
  }

  private async closeClients(): Promise<unknown[]> {
    const openClients = this.clients.splice(0).reverse();
    const results = await Promise.all(openClients.map((client) => this.closeClient(client)));
    return results.flatMap((error) => error === undefined ? [] : [error]);
  }

  private async closeClient(openClient: OpenClient): Promise<unknown | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(
        `Closing MCP server "${openClient.serverName}" timed out after ${this.closeTimeoutMs}ms.`,
      )), this.closeTimeoutMs);
    });
    try {
      await Promise.race([openClient.client.close(), timeoutPromise]);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export function createMcpAgentToolName(serverName: string, toolName: string): string {
  const base = `mcp__${normalizeToolNameSegment(serverName, "server")}__${normalizeToolNameSegment(toolName, "tool")}`;
  if (base.length <= TOOL_NAME_LIMIT) return base;

  const hash = createHash("sha256")
    .update(`${serverName}\0${toolName}`)
    .digest("hex")
    .slice(0, 10);
  return `${base.slice(0, TOOL_NAME_LIMIT - hash.length - 2)}__${hash}`;
}

export function normalizeStdioConfig(
  config: McpStdioServerConfig,
  processEnv: NodeJS.ProcessEnv = process.env,
): McpStdioTransportConfig {
  const inheritedEnvironment = config.env === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries({ ...processEnv, ...config.env })
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  return {
    // @ai-sdk/mcp uses cross-spawn, which resolves npm/npx through PATHEXT and
    // applies cmd.exe escaping on Windows. Appending `.cmd` here would bypass
    // that portable command-resolution contract.
    command: config.command,
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(inheritedEnvironment === undefined ? {} : { env: inheritedEnvironment }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    // The SDK transport does not consume a piped stderr stream; inheriting it
    // prevents verbose MCP servers from blocking on a full pipe buffer.
    stderr: "inherit",
  };
}

function createDefaultStdioTransport(config: McpStdioTransportConfig): MCPTransport {
  // This package subpath is ESM with an exports map. TypeScript's legacy
  // `moduleResolution: Node` cannot resolve its declarations, while Electron's
  // Node 24 runtime can load it from CommonJS. Keep the interop workaround
  // isolated here instead of weakening resolution for the entire main process.
  const module = require("@ai-sdk/mcp/mcp-stdio") as {
    Experimental_StdioMCPTransport: new (
      transportConfig: McpStdioTransportConfig,
    ) => MCPTransport;
  };
  return withWindowsStdioProcessTreeCleanup(
    new module.Experimental_StdioMCPTransport(config),
  );
}

export function classifyMcpToolApproval(definition: Pick<
  McpToolDefinition,
  "annotations"
>): {
  requiresApproval: boolean;
  reason: "read-only" | "destructive" | "unclassified";
  readOnlyHint: boolean;
  destructiveHint: boolean;
} {
  const annotations = definition.annotations as Record<string, unknown> | undefined;
  const readOnlyHint = annotations?.readOnlyHint === true;
  const destructiveHint = annotations?.destructiveHint === true;
  if (destructiveHint) {
    return { requiresApproval: true, reason: "destructive", readOnlyHint, destructiveHint };
  }
  if (readOnlyHint) {
    // MCP annotations are untrusted hints, not an authorization boundary. A
    // future explicit per-server trust policy may opt read-only tools out.
    return { requiresApproval: true, reason: "read-only", readOnlyHint, destructiveHint };
  }
  return {
    requiresApproval: true,
    reason: "unclassified",
    readOnlyHint,
    destructiveHint,
  };
}

async function listAllTools(
  client: MCPClient,
  signal: AbortSignal,
  timeout: number,
): Promise<McpToolDefinition[]> {
  const definitions: McpToolDefinition[] = [];
  const seenCursors = new Set<string>();
  let pages = 0;
  let definitionBytes = 0;
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    pages += 1;
    if (pages > MAX_TOOL_DISCOVERY_PAGES) {
      throw new Error(`MCP tool discovery exceeded ${MAX_TOOL_DISCOVERY_PAGES} pages.`);
    }
    const result = await client.listTools({
      ...(cursor === undefined ? {} : { params: { cursor } }),
      options: { signal, timeout },
    });
    signal.throwIfAborted();
    definitionBytes += Buffer.byteLength(JSON.stringify(result.tools), "utf8");
    if (definitionBytes > MAX_TOOL_DEFINITION_BYTES) {
      throw new Error(
        `MCP tool definitions exceeded ${MAX_TOOL_DEFINITION_BYTES} UTF-8 bytes.`,
      );
    }
    if (definitions.length + result.tools.length > MAX_TOOLS_PER_SERVER) {
      throw new Error(`MCP server exposed more than ${MAX_TOOLS_PER_SERVER} tools.`);
    }
    definitions.push(...result.tools);
    const nextCursor = result.nextCursor;
    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new Error(`MCP tool discovery repeated cursor "${nextCursor}".`);
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
  } while (cursor !== undefined);
  return definitions;
}

function resolveHttpHeaders(
  serverName: string,
  config: McpHttpServerConfig,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!config.headers) return undefined;
  const values = { ...processEnv, ...config.env };
  return Object.fromEntries(Object.entries(config.headers).map(([header, value]) => {
    const resolvedValue = value.replace(
      /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        const resolved = values[name];
        if (resolved === undefined) {
          throw new Error(
            `MCP server "${serverName}" header "${header}" references missing environment variable "${name}".`,
          );
        }
        return resolved;
      },
    );
    if (/[\r\n]/.test(resolvedValue)) {
      throw new Error(
        `MCP server "${serverName}" header "${header}" resolved to an unsafe value.`,
      );
    }
    return [header, resolvedValue];
  }));
}

function isHttpTransportIncompatibility(error: unknown): boolean {
  const statusCode = error !== null
    && typeof error === "object"
    && typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
  if (statusCode === 405 || statusCode === 406 || statusCode === 415) return true;

  const message = error instanceof Error ? error.message : String(error);
  return /does not support HTTP transport.*(?:use|using) [`']?sse/i.test(message)
    || /try using [`']?sse[`']? transport instead/i.test(message);
}

function normalizeToolNameSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return normalized || fallback;
}
