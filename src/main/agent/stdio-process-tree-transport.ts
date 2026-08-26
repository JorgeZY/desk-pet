import { execFile } from "node:child_process";
import { join } from "node:path";
import type { MCPTransport } from "@ai-sdk/mcp";

const DEFAULT_TASKKILL_TIMEOUT_MS = 2_000;

interface SdkChildProcessHandle {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (...args: unknown[]) => unknown;
  once: (...args: unknown[]) => unknown;
}

export interface StdioProcessTreeCleanupDependencies {
  platform?: NodeJS.Platform;
  currentPid?: number;
  taskkillTimeoutMs?: number;
  terminateProcessTree?: (pid: number, timeoutMs: number) => Promise<void>;
}

/**
 * Adds Windows process-tree cleanup to the AI SDK stdio transport.
 *
 * The SDK intentionally does not expose its spawned ChildProcess. This wrapper
 * only uses the current runtime `process` field when it still has the shape and
 * object identity of the child observed after start. A successful start that
 * cannot expose that exact handle is rejected immediately, preventing an SDK
 * private-field change from silently reintroducing orphaned process trees.
 */
export function withWindowsStdioProcessTreeCleanup(
  transport: MCPTransport,
  dependencies: StdioProcessTreeCleanupDependencies = {},
): MCPTransport {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") return transport;

  return new WindowsStdioProcessTreeTransport(transport, {
    currentPid: dependencies.currentPid ?? process.pid,
    taskkillTimeoutMs: normalizeTimeout(dependencies.taskkillTimeoutMs),
    terminateProcessTree: dependencies.terminateProcessTree ?? terminateWindowsProcessTree,
  });
}

/** Argument-safe Windows tree termination for one exact PID. */
export function terminateWindowsProcessTree(
  pid: number,
  timeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS,
): Promise<void> {
  if (!isSafeChildPid(pid, process.pid)) return Promise.resolve();
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) {
    return Promise.reject(new Error(
      `Unable to locate taskkill.exe for MCP wrapper PID ${pid}: SystemRoot is missing.`,
    ));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      execFile(
        join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          timeout: normalizeTimeout(timeoutMs),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve();
            return;
          }
          const output = [stderr, stdout]
            .map((value) => String(value).trim())
            .filter(Boolean)
            .join("; ");
          const details = [
            "code" in error ? `code=${String(error.code)}` : "",
            "killed" in error ? `killed=${String(error.killed)}` : "",
            "signal" in error ? `signal=${String(error.signal)}` : "",
          ].filter(Boolean).join(", ");
          reject(new Error(
            `taskkill /PID ${pid} /T /F failed${details ? ` (${details})` : ""}: `
            + (output || error.message),
            { cause: error },
          ));
        },
      );
    } catch (error) {
      reject(new Error(
        `Unable to launch taskkill for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ));
    }
  });
}

class WindowsStdioProcessTreeTransport implements MCPTransport {
  private readonly inner: MCPTransport;
  private readonly currentPid: number;
  private readonly taskkillTimeoutMs: number;
  private readonly terminateProcessTree: (pid: number, timeoutMs: number) => Promise<void>;
  private ownedProcess?: SdkChildProcessHandle;
  private closePromise?: Promise<void>;

  constructor(
    inner: MCPTransport,
    options: Required<Omit<StdioProcessTreeCleanupDependencies, "platform">>,
  ) {
    this.inner = inner;
    this.currentPid = options.currentPid;
    this.taskkillTimeoutMs = options.taskkillTimeoutMs;
    this.terminateProcessTree = options.terminateProcessTree;
  }

  get supportsProtocolVersionDiscovery(): boolean | undefined {
    return this.inner.supportsProtocolVersionDiscovery;
  }

  get supportsMcpToolParameterHeaders(): boolean | undefined {
    return this.inner.supportsMcpToolParameterHeaders;
  }

  get protocolVersion(): string | undefined {
    return this.inner.protocolVersion;
  }

  set protocolVersion(version: string | undefined) {
    this.inner.protocolVersion = version;
  }

  get onclose(): MCPTransport["onclose"] {
    return this.inner.onclose;
  }

  set onclose(handler: MCPTransport["onclose"]) {
    this.inner.onclose = handler;
  }

  get onerror(): MCPTransport["onerror"] {
    return this.inner.onerror;
  }

  set onerror(handler: MCPTransport["onerror"]) {
    this.inner.onerror = handler;
  }

  get onmessage(): MCPTransport["onmessage"] {
    return this.inner.onmessage;
  }

  set onmessage(handler: MCPTransport["onmessage"]) {
    this.inner.onmessage = handler;
  }

  async start(): Promise<void> {
    try {
      await this.inner.start();
    } catch (error) {
      // Preserve the transport's original startup failure. Capturing here only
      // helps a subsequent SDK close target a child that happened to spawn.
      this.captureCurrentProcess();
      throw error;
    }

    if (!this.captureCurrentProcess()) {
      const compatibilityError = new Error(
        "AI SDK stdio transport compatibility error: unable to capture the spawned "
        + "Windows wrapper process; the transport was closed to prevent an orphaned process tree.",
      );
      try {
        await this.close();
      } catch (closeError) {
        throw new AggregateError([compatibilityError, closeError], compatibilityError.message);
      }
      throw compatibilityError;
    }
  }

  send(...args: Parameters<MCPTransport["send"]>): Promise<void> {
    return this.inner.send(...args);
  }

  setProtocolVersion(version: string): void {
    if (this.inner.setProtocolVersion) {
      this.inner.setProtocolVersion(version);
      return;
    }
    this.inner.protocolVersion = version;
  }

  close(...args: Parameters<MCPTransport["close"]>): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeOnce(args);
      // The AI SDK abort path can discard transport.close() after invoking it.
      // Mark the promise handled internally while returning the original
      // promise so direct callers still observe cleanup failures.
      void this.closePromise.catch(() => undefined);
    }
    return this.closePromise;
  }

  private async closeOnce(args: Parameters<MCPTransport["close"]>): Promise<void> {
    const cleanup = this.getOwnedProcessForClose();
    let treeKillError: unknown = cleanup.compatibilityError;
    try {
      if (cleanup.processHandle) {
        // Run tree termination before the SDK kills the wrapper process itself;
        // otherwise cmd.exe may disappear before taskkill can enumerate children.
        try {
          await runWithin(
            () => this.terminateProcessTree(cleanup.processHandle!.pid, this.taskkillTimeoutMs),
            this.taskkillTimeoutMs,
            `taskkill for MCP wrapper PID ${cleanup.processHandle.pid} timed out after ${this.taskkillTimeoutMs}ms.`,
          );
        } catch (error) {
          treeKillError = treeKillError === undefined
            ? error
            : new AggregateError(
              [treeKillError, error],
              "The AI SDK stdio process identity changed and its captured tree could not be terminated.",
            );
        }
      }
    } finally {
      // Preserve the SDK cleanup path even if tree discovery or taskkill fails.
      try {
        await this.inner.close(...args);
      } catch (closeError) {
        if (treeKillError !== undefined) {
          throw new AggregateError(
            [treeKillError, closeError],
            "Failed to terminate the Windows MCP process tree and close its SDK transport.",
          );
        }
        throw closeError;
      }
    }
    if (treeKillError !== undefined) {
      throw treeKillError;
    }
  }

  private captureCurrentProcess(): boolean {
    const processHandle = readSdkChildProcess(this.inner, this.currentPid);
    if (!processHandle) return false;
    this.ownedProcess = processHandle;
    return true;
  }

  private getOwnedProcessForClose(): {
    processHandle?: SdkChildProcessHandle;
    compatibilityError?: Error;
  } {
    const current = readSdkChildProcess(this.inner, this.currentPid);
    if (!this.ownedProcess && current) this.ownedProcess = current;
    const owned = this.ownedProcess;
    if (!owned) return {};

    const processHandle = owned.exitCode === null && owned.signalCode === null
      ? owned
      : undefined;
    if (current && current !== owned) {
      return {
        processHandle,
        compatibilityError: new Error(
          `AI SDK stdio transport compatibility error: the Windows wrapper process identity `
          + `changed from captured PID ${owned.pid} to PID ${current.pid}; only the captured tree was targeted.`,
        ),
      };
    }
    return { processHandle };
  }
}

function readSdkChildProcess(
  transport: MCPTransport,
  currentPid: number,
): SdkChildProcessHandle | undefined {
  try {
    const candidate = (transport as MCPTransport & { process?: unknown }).process;
    if (!candidate || typeof candidate !== "object") return undefined;

    const child = candidate as Partial<SdkChildProcessHandle>;
    if (!isSafeChildPid(child.pid, currentPid)) return undefined;
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    if (typeof child.kill !== "function" || typeof child.once !== "function") return undefined;
    return child as SdkChildProcessHandle;
  } catch {
    return undefined;
  }
}

function isSafeChildPid(pid: unknown, currentPid: number): pid is number {
  return Number.isSafeInteger(pid) && Number(pid) > 0 && pid !== currentPid;
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : DEFAULT_TASKKILL_TIMEOUT_MS;
}

async function runWithin(
  action: () => Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const operation = action();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
