import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  resolveSpeechModelPaths,
  SpeechModelManager,
  type SpeechScriptInvocation,
} from "./speech-model-manager";

const temporaryDirectories: string[] = [];
const testDirectory = join(process.cwd(), ".test-tmp", "speech-models");

async function temporaryDirectory(): Promise<string> {
  await fs.mkdir(testDirectory, { recursive: true });
  const directory = await fs.mkdtemp(join(testDirectory, "desk-pet-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SpeechModelManager", () => {
  it("keeps both speech models under the shared root models directory", () => {
    const paths = resolveSpeechModelPaths(join("application", "models"));
    expect(paths.root).toBe(join("application", "models", "speech"));
    expect(paths.streaming.encoder).toContain(
      join("speech", "streaming-paraformer-bilingual-zh-en", "encoder.int8.onnx"),
    );
    expect(paths.final.model).toContain(
      join("speech", "sense-voice-zh-en-ja-ko-yue-int8", "model.int8.onnx"),
    );
  });

  it("reuses complete cached models without making a network request", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveSpeechModelPaths(directory);
    await fs.mkdir(paths.streaming.directory, { recursive: true });
    await fs.mkdir(paths.final.directory, { recursive: true });
    await Promise.all([
      fs.writeFile(paths.streaming.encoder, "encoder"),
      fs.writeFile(paths.streaming.decoder, "decoder"),
      fs.writeFile(paths.streaming.tokens, "tokens"),
      fs.writeFile(join(paths.streaming.directory, "encoder.onnx"), "unused fp32 encoder"),
      fs.writeFile(join(paths.streaming.directory, "decoder.onnx"), "unused fp32 decoder"),
      fs.writeFile(paths.final.model, "model"),
      fs.writeFile(paths.final.tokens, "tokens"),
    ]);
    const manager = new SpeechModelManager(directory, join(directory, "scripts"), async () => {
      throw new Error("should not run scripts for cached speech models");
    });
    await expect(manager.isReady()).resolves.toBe(true);
    await expect(fs.access(join(paths.streaming.directory, "encoder.onnx"))).rejects.toThrow();
    await expect(fs.access(join(paths.streaming.directory, "decoder.onnx"))).rejects.toThrow();
    await expect(
      manager.prepare(new AbortController().signal, () => undefined),
    ).resolves.toEqual(paths);
  });

  it("runs the reference-style PowerShell scripts in streaming then final order", async () => {
    const directory = await temporaryDirectory();
    const scriptDirectory = join(directory, "scripts");
    const paths = resolveSpeechModelPaths(directory);
    const invocations: SpeechScriptInvocation[] = [];
    const manager = new SpeechModelManager(directory, scriptDirectory, async (invocation) => {
      invocations.push(invocation);
      if (invocation.scriptPath.endsWith("download-streaming-model.ps1")) {
        await fs.mkdir(paths.streaming.directory, { recursive: true });
        await Promise.all([
          fs.writeFile(paths.streaming.encoder, "encoder"),
          fs.writeFile(paths.streaming.decoder, "decoder"),
          fs.writeFile(paths.streaming.tokens, "tokens"),
        ]);
      } else {
        await fs.mkdir(paths.final.directory, { recursive: true });
        await Promise.all([
          fs.writeFile(paths.final.model, "model"),
          fs.writeFile(paths.final.tokens, "tokens"),
        ]);
      }
    });

    await manager.prepare(new AbortController().signal, () => undefined, true);

    expect(invocations.map((value) => value.scriptPath)).toEqual([
      join(scriptDirectory, "download-streaming-model.ps1"),
      join(scriptDirectory, "download-models.ps1"),
    ]);
    expect(invocations.every((value) => value.modelRoot === directory && value.force)).toBe(true);
  });
});
