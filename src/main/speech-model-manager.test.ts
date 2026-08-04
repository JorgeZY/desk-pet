import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  discoverSpeechModels,
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

  it("uses discovered models in place without copying them into the managed root", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "my-offline-model-backup");
    const streaming = join(source, "anything", "realtime-files");
    const final = join(source, "another-name", "final-files");
    await Promise.all([fs.mkdir(streaming, { recursive: true }), fs.mkdir(final, { recursive: true })]);
    await Promise.all([
      fs.writeFile(join(streaming, "custom_encoder.onnx"), "fp32 encoder"),
      fs.writeFile(join(streaming, "custom_encoder_int8.onnx"), "int8 encoder"),
      fs.writeFile(join(streaming, "my_decoder_int8.onnx"), "int8 decoder"),
      fs.writeFile(join(streaming, "tokens-preview.txt"), "stream tokens"),
      fs.writeFile(join(final, "sensevoice-custom-int8.onnx"), "sense voice"),
      fs.writeFile(join(final, "token.txt"), "final tokens"),
    ]);

    const discovered = await discoverSpeechModels(source);
    expect(discovered.streaming.encoder).toBe(join(streaming, "custom_encoder_int8.onnx"));
    expect(discovered.final.model).toBe(join(final, "sensevoice-custom-int8.onnx"));

    const modelRoot = join(directory, "managed-models");
    const manager = new SpeechModelManager(modelRoot, join(directory, "scripts"));
    const paths = await manager.importFromDirectory(source);
    expect(paths.streaming.encoder).toBe(join(streaming, "custom_encoder_int8.onnx"));
    expect(paths.streaming.decoder).toBe(join(streaming, "my_decoder_int8.onnx"));
    expect(paths.streaming.tokens).toBe(join(streaming, "tokens-preview.txt"));
    expect(paths.final.model).toBe(join(final, "sensevoice-custom-int8.onnx"));
    expect(paths.final.tokens).toBe(join(final, "token.txt"));
    expect(manager.displayedDirectory).toBe(source);
    await expect(fs.access(modelRoot)).rejects.toThrow();
    await expect(manager.isReady()).resolves.toBe(true);
  });

  it("restores an imported directory without creating a managed speech folder", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "external-models");
    const streaming = join(source, "stream");
    const final = join(source, "final");
    await Promise.all([fs.mkdir(streaming, { recursive: true }), fs.mkdir(final, { recursive: true })]);
    await Promise.all([
      fs.writeFile(join(streaming, "encoder.int8.onnx"), "encoder"),
      fs.writeFile(join(streaming, "decoder.int8.onnx"), "decoder"),
      fs.writeFile(join(streaming, "tokens.txt"), "tokens"),
      fs.writeFile(join(final, "model.int8.onnx"), "model"),
      fs.writeFile(join(final, "tokens.txt"), "tokens"),
    ]);
    const modelRoot = join(directory, "managed-models");
    const manager = new SpeechModelManager(modelRoot, join(directory, "scripts"), undefined, source);

    await expect(manager.isReady()).resolves.toBe(true);
    expect(manager.paths.streaming.directory).toBe(streaming);
    expect(manager.paths.final.directory).toBe(final);
    await expect(fs.access(modelRoot)).rejects.toThrow();
  });

  it("rejects incomplete imports without touching existing managed models", async () => {
    const directory = await temporaryDirectory();
    const modelRoot = join(directory, "managed-models");
    const paths = resolveSpeechModelPaths(modelRoot);
    await Promise.all([
      fs.mkdir(paths.streaming.directory, { recursive: true }),
      fs.mkdir(paths.final.directory, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(paths.streaming.encoder, "existing encoder"),
      fs.writeFile(paths.streaming.decoder, "existing decoder"),
      fs.writeFile(paths.streaming.tokens, "existing tokens"),
      fs.writeFile(paths.final.model, "existing model"),
      fs.writeFile(paths.final.tokens, "existing final tokens"),
    ]);
    const incomplete = join(directory, "incomplete");
    await fs.mkdir(incomplete, { recursive: true });
    await fs.writeFile(join(incomplete, "encoder.onnx"), "missing decoder and tokens");

    const manager = new SpeechModelManager(modelRoot, join(directory, "scripts"));
    await expect(manager.importFromDirectory(incomplete)).rejects.toThrow("没有在所选目录中找到完整的");
    await expect(fs.readFile(paths.streaming.encoder, "utf8")).resolves.toBe("existing encoder");
    await expect(fs.readFile(paths.final.model, "utf8")).resolves.toBe("existing model");
  });
});
