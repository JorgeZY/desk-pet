import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CaptionDownloadProgress } from "../shared/types";
import {
  discoverSpeechModels,
  resolveCaptionModelPaths,
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

    const captionPaths = resolveCaptionModelPaths(join("application", "models"));
    expect(captionPaths).toEqual({
      directory: join(
        "application",
        "models",
        "speech",
        "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
      ),
      encoder: join(
        "application",
        "models",
        "speech",
        "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
        "encoder.int8.onnx",
      ),
      decoder: join(
        "application",
        "models",
        "speech",
        "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
        "decoder.int8.onnx",
      ),
      joiner: join(
        "application",
        "models",
        "speech",
        "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
        "joiner.int8.onnx",
      ),
      tokens: join(
        "application",
        "models",
        "speech",
        "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
        "tokens.txt",
      ),
      featureDim: 128,
    });
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

  it("prepares the managed English caption model without changing imported F8 models", async () => {
    const directory = await temporaryDirectory();
    const modelRoot = join(directory, "managed-models");
    const scriptDirectory = join(directory, "scripts");
    const importedRoot = join(directory, "imported-speech");
    const importedStreaming = join(importedRoot, "streaming");
    const importedFinal = join(importedRoot, "final");
    await Promise.all([
      fs.mkdir(importedStreaming, { recursive: true }),
      fs.mkdir(importedFinal, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(join(importedStreaming, "encoder.int8.onnx"), "imported encoder"),
      fs.writeFile(join(importedStreaming, "decoder.int8.onnx"), "imported decoder"),
      fs.writeFile(join(importedStreaming, "tokens.txt"), "imported tokens"),
      fs.writeFile(join(importedFinal, "model.int8.onnx"), "imported final"),
      fs.writeFile(join(importedFinal, "tokens.txt"), "imported final tokens"),
    ]);

    const captionPaths = resolveCaptionModelPaths(modelRoot);
    const invocations: SpeechScriptInvocation[] = [];
    const manager = new SpeechModelManager(modelRoot, scriptDirectory, async (invocation) => {
      invocations.push(invocation);
      await fs.mkdir(captionPaths.directory, { recursive: true });
      await Promise.all([
        fs.writeFile(captionPaths.encoder, "caption encoder"),
        fs.writeFile(captionPaths.decoder, "caption decoder"),
        fs.writeFile(captionPaths.joiner, "caption joiner"),
        fs.writeFile(captionPaths.tokens, "caption tokens"),
      ]);
    });
    const importedPaths = await manager.importFromDirectory(importedRoot);
    const progress: CaptionDownloadProgress[] = [];

    await expect(manager.prepareCaption(
      new AbortController().signal,
      (value) => progress.push(value),
    )).resolves.toEqual(captionPaths);

    expect(invocations).toEqual([{
      scriptPath: join(scriptDirectory, "download-caption-model.ps1"),
      modelRoot,
      force: false,
      signal: expect.any(AbortSignal),
    }]);
    expect(progress).toEqual([
      { receivedBytes: 0 },
      {
        receivedBytes: 1,
        totalBytes: 1,
        percent: 100,
      },
    ]);
    expect(manager.displayedDirectory).toBe(importedRoot);
    expect(manager.paths).toBe(importedPaths);
    expect(manager.paths.streaming.directory).toBe(importedStreaming);
    expect(manager.paths.final.directory).toBe(importedFinal);
    await expect(manager.isCaptionReady()).resolves.toBe(true);
    await expect(manager.isReady()).resolves.toBe(true);
  });

  it("reuses a complete English caption model without touching F8 model readiness", async () => {
    const directory = await temporaryDirectory();
    const captionPaths = resolveCaptionModelPaths(directory);
    await fs.mkdir(captionPaths.directory, { recursive: true });
    await Promise.all([
      fs.writeFile(captionPaths.encoder, "caption encoder"),
      fs.writeFile(captionPaths.decoder, "caption decoder"),
      fs.writeFile(captionPaths.joiner, "caption joiner"),
      fs.writeFile(captionPaths.tokens, "caption tokens"),
    ]);
    const manager = new SpeechModelManager(directory, join(directory, "scripts"), async () => {
      throw new Error("should not download a cached caption model");
    });

    await expect(manager.prepareCaption(
      new AbortController().signal,
      () => undefined,
    )).resolves.toEqual(captionPaths);

    await expect(manager.isCaptionReady()).resolves.toBe(true);
    await expect(manager.isReady()).resolves.toBe(false);
  });

  it("does not treat a transducer model without its joiner as ready", async () => {
    const directory = await temporaryDirectory();
    const captionPaths = resolveCaptionModelPaths(directory);
    await fs.mkdir(captionPaths.directory, { recursive: true });
    await Promise.all([
      fs.writeFile(captionPaths.encoder, "caption encoder"),
      fs.writeFile(captionPaths.decoder, "caption decoder"),
      fs.writeFile(captionPaths.tokens, "caption tokens"),
    ]);
    const manager = new SpeechModelManager(directory, join(directory, "scripts"));

    await expect(manager.isCaptionReady()).resolves.toBe(false);
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

  it("does not import the English caption transducer as the F8 Paraformer", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "mixed-speech-models");
    const caption = join(source, "a-nemotron-caption");
    const streaming = join(source, "z-paraformer");
    const final = join(source, "zz-sensevoice");
    await Promise.all([
      fs.mkdir(caption, { recursive: true }),
      fs.mkdir(streaming, { recursive: true }),
      fs.mkdir(final, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(join(caption, "encoder.int8.onnx"), "caption encoder"),
      fs.writeFile(join(caption, "decoder.int8.onnx"), "caption decoder"),
      fs.writeFile(join(caption, "joiner.int8.onnx"), "caption joiner"),
      fs.writeFile(join(caption, "tokens.txt"), "caption tokens"),
      fs.writeFile(join(streaming, "encoder.int8.onnx"), "paraformer encoder"),
      fs.writeFile(join(streaming, "decoder.int8.onnx"), "paraformer decoder"),
      fs.writeFile(join(streaming, "tokens.txt"), "paraformer tokens"),
      fs.writeFile(join(final, "model.int8.onnx"), "sensevoice model"),
      fs.writeFile(join(final, "tokens.txt"), "sensevoice tokens"),
    ]);

    const discovered = await discoverSpeechModels(source);
    expect(discovered.streaming.encoder).toBe(join(streaming, "encoder.int8.onnx"));
    expect(discovered.streaming.decoder).toBe(join(streaming, "decoder.int8.onnx"));
    expect(discovered.final.model).toBe(join(final, "model.int8.onnx"));

    await fs.rm(final, { recursive: true });
    await expect(discoverSpeechModels(source)).rejects.toThrow("SenseVoice model/tokens");
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

    await fs.rm(source, { recursive: true, force: true });
    await expect(manager.isReady()).resolves.toBe(true);
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
