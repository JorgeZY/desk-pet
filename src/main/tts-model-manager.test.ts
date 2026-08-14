import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  discoverTtsModel,
  resolveTtsModelPaths,
  TtsModelManager,
  type TtsScriptInvocation,
} from "./tts-model-manager";

const temporaryDirectories: string[] = [];
const testDirectory = join(process.cwd(), ".test-tmp", "tts-models");

async function temporaryDirectory(): Promise<string> {
  await fs.mkdir(testDirectory, { recursive: true });
  const directory = await fs.mkdtemp(join(testDirectory, "desk-pet-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function installManagedModel(directory: string, paths = resolveTtsModelPaths(directory)): Promise<void> {
  await fs.mkdir(paths.directory, { recursive: true });
  await fs.mkdir(paths.dataDir!, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.model, "model"),
    fs.writeFile(paths.lexicon, "lexicon"),
    fs.writeFile(paths.tokens, "tokens"),
    fs.writeFile(join(paths.dataDir!, "phontab"), "data"),
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TtsModelManager", () => {
  it("keeps the TTS model and espeak data under the shared speech root", () => {
    const paths = resolveTtsModelPaths(join("application", "models"));
    expect(paths.root).toBe(join("application", "models", "speech"));
    expect(paths.model).toBe(
      join("application", "models", "speech", "vits-melo-tts-zh_en", "model.onnx"),
    );
    expect(paths.lexicon).toContain("lexicon.txt");
    expect(paths.tokens).toContain("tokens.txt");
    expect(paths.dataDir).toBe(join("application", "models", "speech", "espeak-ng-data"));
  });

  it("reuses complete cached models without running the download script", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveTtsModelPaths(directory);
    await installManagedModel(directory, paths);
    const manager = new TtsModelManager(directory, join(directory, "scripts"), async () => {
      throw new Error("should not run scripts for cached TTS models");
    });

    await expect(manager.isReady()).resolves.toBe(true);
    await expect(
      manager.prepare(new AbortController().signal, () => undefined),
    ).resolves.toEqual(paths);
  });

  it("runs the download script when the model or espeak data is missing", async () => {
    const directory = await temporaryDirectory();
    const scriptDirectory = join(directory, "scripts");
    const paths = resolveTtsModelPaths(directory);
    const invocations: TtsScriptInvocation[] = [];
    const manager = new TtsModelManager(directory, scriptDirectory, async (invocation) => {
      invocations.push(invocation);
      await installManagedModel(directory, paths);
    });

    await expect(manager.isReady()).resolves.toBe(false);
    await expect(manager.prepare(new AbortController().signal, () => undefined)).resolves.toEqual(paths);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.scriptPath).toContain("download-tts-model.ps1");
    expect(invocations[0]?.modelRoot).toBe(directory);
    expect(invocations[0]?.force).toBe(false);
  });

  it("fails when the script leaves the model incomplete", async () => {
    const directory = await temporaryDirectory();
    const manager = new TtsModelManager(directory, join(directory, "scripts"), async () => undefined);

    await expect(
      manager.prepare(new AbortController().signal, () => undefined),
    ).rejects.toThrow("模型文件不完整");
  });

  it("discovers a model and its espeak data from an imported directory", async () => {
    const directory = await temporaryDirectory();
    const modelDirectory = join(directory, "my-models", "vits-melo-tts-zh_en");
    const dataDirectory = join(directory, "my-models", "espeak-ng-data");
    await fs.mkdir(modelDirectory, { recursive: true });
    await fs.mkdir(dataDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(join(modelDirectory, "model.onnx"), "model"),
      fs.writeFile(join(modelDirectory, "lexicon.txt"), "lexicon"),
      fs.writeFile(join(modelDirectory, "tokens.txt"), "tokens"),
      fs.writeFile(join(dataDirectory, "phontab"), "data"),
    ]);

    const discovered = await discoverTtsModel(directory);
    expect(discovered.model).toBe(join(modelDirectory, "model.onnx"));
    expect(discovered.dataDir).toBe(dataDirectory);

    const manager = new TtsModelManager(directory, join(directory, "scripts"));
    const paths = await manager.importFromDirectory(directory);
    expect(paths.model).toBe(join(modelDirectory, "model.onnx"));
    expect(manager.displayedDirectory).toBe(directory);
    await expect(manager.isReady()).resolves.toBe(true);
  });

  it("rejects directories without a complete TTS model", async () => {
    const directory = await temporaryDirectory();
    await fs.mkdir(join(directory, "partial"), { recursive: true });
    await fs.writeFile(join(directory, "partial", "model.onnx"), "model");

    await expect(discoverTtsModel(directory)).rejects.toThrow("完整的 TTS 模型");
  });

  it("returns to managed models after clearing the imported directory", async () => {
    const directory = await temporaryDirectory();
    const paths = resolveTtsModelPaths(directory);
    const manager = new TtsModelManager(directory, join(directory, "scripts"), undefined, "C:/imported");

    manager.setImportedDirectory("");
    expect(manager.paths.model).toBe(paths.model);
  });
});
