import type { MCPTransport } from "@ai-sdk/mcp";
import { describe, expect, it, vi } from "vitest";
import { withWindowsStdioProcessTreeCleanup } from "./stdio-process-tree-transport";

interface FakeChildProcess {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function childProcess(pid: number): FakeChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    once: vi.fn(),
  };
}

function fakeTransport(processHandle?: unknown): MCPTransport & { process?: unknown } {
  return {
    process: processHandle,
    supportsProtocolVersionDiscovery: true,
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("Windows stdio MCP process-tree cleanup", () => {
  it("leaves non-Windows transports unchanged", async () => {
    const inner = fakeTransport(childProcess(4_201));
    const terminateProcessTree = vi.fn(async () => undefined);

    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "linux",
      currentPid: 10,
      terminateProcessTree,
    });

    expect(transport).toBe(inner);
    await transport.start();
    await transport.close();
    expect(inner.close).toHaveBeenCalledOnce();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("targets only the exact SDK wrapper PID and closes idempotently", async () => {
    const order: string[] = [];
    const processHandle = childProcess(4_202);
    const inner = fakeTransport(processHandle);
    vi.mocked(inner.close).mockImplementation(async () => {
      order.push("sdk-close");
    });
    const terminateProcessTree = vi.fn(async (pid: number) => {
      order.push(`taskkill:${pid}`);
    });
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      taskkillTimeoutMs: 25,
      terminateProcessTree,
    });

    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    expect(inner.onmessage).toBe(onmessage);
    await transport.start();
    const firstClose = transport.close();
    const secondClose = transport.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(4_202, 25);
    expect(inner.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["taskkill:4202", "sdk-close"]);
  });

  it("rejects a successful start when the SDK process field cannot be captured", async () => {
    const inner = fakeTransport({ pid: 4_203 });
    const terminateProcessTree = vi.fn(async () => undefined);
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      terminateProcessTree,
    });

    await expect(transport.start()).rejects.toThrow("compatibility error");
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("targets the captured PID and reports a different process identity", async () => {
    const originalProcess = childProcess(4_203);
    const inner = fakeTransport(originalProcess);
    const terminateProcessTree = vi.fn(async () => undefined);
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      terminateProcessTree,
    });
    await transport.start();

    inner.process = childProcess(4_204);
    await expect(transport.close()).rejects.toThrow("identity changed");

    expect(terminateProcessTree).toHaveBeenCalledWith(4_203, 2_000);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("still targets the captured PID when the SDK process field disappears", async () => {
    const originalProcess = childProcess(4_208);
    const inner = fakeTransport(originalProcess);
    const terminateProcessTree = vi.fn(async () => undefined);
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      terminateProcessTree,
    });
    await transport.start();

    inner.process = undefined;
    await transport.close();

    expect(terminateProcessTree).toHaveBeenCalledWith(4_208, 2_000);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("preserves an original SDK start failure when no child handle is available", async () => {
    const inner = fakeTransport();
    vi.mocked(inner.start).mockRejectedValueOnce(new Error("spawn failed"));
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
    });

    await expect(transport.start()).rejects.toThrow("spawn failed");
    expect(inner.close).not.toHaveBeenCalled();
  });

  it("never targets the current Electron process", async () => {
    const inner = fakeTransport(childProcess(4_205));
    const terminateProcessTree = vi.fn(async () => undefined);
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 4_205,
      terminateProcessTree,
    });

    await expect(transport.start()).rejects.toThrow("compatibility error");

    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("reports taskkill failure after still running SDK close", async () => {
    const inner = fakeTransport(childProcess(4_207));
    const terminateProcessTree = vi.fn(async () => {
      throw new Error("access denied");
    });
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      terminateProcessTree,
    });

    await transport.start();
    await expect(transport.close()).rejects.toThrow("access denied");

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it("observes an abandoned close rejection while preserving it for callers", async () => {
    const inner = fakeTransport(childProcess(4_209));
    const terminateProcessTree = vi.fn(async () => {
      throw new Error("access denied");
    });
    const transport = withWindowsStdioProcessTreeCleanup(inner, {
      platform: "win32",
      currentPid: 10,
      terminateProcessTree,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);

    try {
      await transport.start();
      const closing = transport.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await expect(closing).rejects.toThrow("access denied");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("bounds a hanging taskkill attempt before running SDK close", async () => {
    vi.useFakeTimers();
    try {
      const inner = fakeTransport(childProcess(4_206));
      const terminateProcessTree = vi.fn(() => new Promise<void>(() => undefined));
      const transport = withWindowsStdioProcessTreeCleanup(inner, {
        platform: "win32",
        currentPid: 10,
        taskkillTimeoutMs: 50,
        terminateProcessTree,
      });
      await transport.start();

      const closing = transport.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(inner.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      await expect(closing).resolves.toMatchObject({
        message: expect.stringContaining("timed out after 50ms"),
      });

      expect(terminateProcessTree).toHaveBeenCalledWith(4_206, 50);
      expect(inner.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
