import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPTransport } from "@ai-sdk/mcp";
import { expect, it } from "vitest";
import {
  terminateWindowsProcessTree,
  withWindowsStdioProcessTreeCleanup,
} from "./stdio-process-tree-transport";

it.skipIf(process.platform !== "win32")(
  "kills the exact .cmd wrapper tree without touching an unrelated process",
  async (context) => {
    const capability = await probeTaskkillCapability();
    if (!capability.supported) {
      context.skip(`taskkill unavailable for owned test PIDs: ${capability.reason}`);
    }

    const directory = await fs.mkdtemp(join(tmpdir(), "desk-pet-mcp-tree-"));
    const commandPath = join(directory, "persistent-mcp.cmd");
    const scriptPath = join(directory, "persistent-mcp.cjs");
    const pidFile = join(directory, "grandchild.pid");
    let transport: MCPTransport | undefined;
    let wrapperPid: number | undefined;
    let grandchildPid: number | undefined;
    let unrelatedPid: number | undefined;
    let taskkillFailure: unknown;

    try {
      await fs.writeFile(commandPath, [
        "@echo off",
        "\"%MCP_TREE_TEST_NODE%\" \"%MCP_TREE_TEST_SCRIPT%\"",
        "",
      ].join("\r\n"), "utf8");
      await fs.writeFile(scriptPath, [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.env.MCP_TREE_TEST_PID_FILE, String(process.pid));",
        "setInterval(() => undefined, 1_000);",
        "",
      ].join("\n"), "utf8");

      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1_000);"],
        { stdio: "ignore", windowsHide: true },
      );
      await once(unrelated, "spawn");
      unrelatedPid = unrelated.pid;
      expect(unrelatedPid).toBeTypeOf("number");

      const module = require("@ai-sdk/mcp/mcp-stdio") as {
        Experimental_StdioMCPTransport: new (config: {
          command: string;
          env: Record<string, string>;
          stderr: "ignore";
        }) => MCPTransport;
      };
      const inner = new module.Experimental_StdioMCPTransport({
        command: commandPath,
        env: {
          MCP_TREE_TEST_NODE: process.execPath,
          MCP_TREE_TEST_SCRIPT: scriptPath,
          MCP_TREE_TEST_PID_FILE: pidFile,
        },
        stderr: "ignore",
      });
      const targetedPids: number[] = [];
      transport = withWindowsStdioProcessTreeCleanup(inner, {
        platform: "win32",
        terminateProcessTree: async (pid, timeoutMs) => {
          targetedPids.push(pid);
          try {
            await terminateWindowsProcessTree(pid, timeoutMs);
          } catch (error) {
            taskkillFailure = error;
            throw error;
          }
        },
      });

      await transport.start();
      wrapperPid = readSdkWrapperPid(inner);
      grandchildPid = await waitForPidFile(pidFile, 5_000);
      expect(wrapperPid).toBeTypeOf("number");
      expect(wrapperPid).not.toBe(process.pid);
      expect(grandchildPid).not.toBe(wrapperPid);
      expect(await isProcessAlive(grandchildPid)).toBe(true);
      expect(await isProcessAlive(unrelatedPid!)).toBe(true);

      await transport.close();
      try {
        await waitForProcessExit(grandchildPid, 5_000);
      } catch (error) {
        if (taskkillFailure) throw taskkillFailure;
        throw error;
      }

      expect(targetedPids).toEqual([wrapperPid]);
      expect(await isProcessAlive(wrapperPid!)).toBe(false);
      expect(await isProcessAlive(grandchildPid)).toBe(false);
      expect(await isProcessAlive(unrelatedPid!)).toBe(true);
    } finally {
      await transport?.close().catch(() => undefined);
      const cleanupPids = new Set([wrapperPid, grandchildPid, unrelatedPid]);
      for (const pid of cleanupPids) {
        if (pid && pid !== process.pid) await forceCleanupPid(pid);
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

function readSdkWrapperPid(transport: MCPTransport): number {
  const pid = (transport as MCPTransport & { process?: { pid?: unknown } }).process?.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
    throw new Error("AI SDK stdio transport did not expose its spawned wrapper PID.");
  }
  return Number(pid);
}

async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number((await fs.readFile(filePath, "utf8")).trim());
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for the persistent MCP grandchild PID.");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

async function forceCleanupPid(pid: number): Promise<void> {
  await terminateWindowsProcessTree(pid, 2_000).catch(() => undefined);
  if (!await isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await waitForProcessExit(pid, 2_000).catch(() => undefined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeTaskkillCapability(): Promise<{
  supported: boolean;
  reason?: string;
}> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1_000);"],
    { stdio: "ignore", windowsHide: true },
  );
  await once(child, "spawn");
  const pid = child.pid;
  if (!pid) return { supported: false, reason: "probe process has no PID" };

  try {
    await terminateWindowsProcessTree(pid, 2_000);
    await waitForProcessExit(pid, 2_000);
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await forceCleanupPid(pid);
  }
}
