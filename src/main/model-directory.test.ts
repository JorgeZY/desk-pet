import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { migrateModelDirectory, resolveModelDirectory } from "./model-directory";

const temporaryDirectories: string[] = [];
const testDirectory = join(process.cwd(), ".test-tmp", "model-directory");

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

describe("model directory", () => {
  it("uses the application root in development and the executable root when packaged", () => {
    const appPath = join(process.cwd(), "application");
    expect(
      resolveModelDirectory({
        appPath,
        executablePath: join(process.cwd(), "node_modules", "electron.exe"),
        isPackaged: false,
      }),
    ).toBe(join(appPath, "models"));

    const executablePath = join(process.cwd(), "packaged", "desk-pet.exe");
    expect(
      resolveModelDirectory({ appPath: "app.asar", executablePath, isPackaged: true }),
    ).toBe(join(dirname(executablePath), "models"));
  });

  it("copies an existing user-data cache only when the root models directory is absent", async () => {
    const root = await temporaryDirectory();
    const previousDirectory = join(root, "user-data", "models");
    const modelDirectory = join(root, "application", "models");
    await fs.mkdir(previousDirectory, { recursive: true });
    await fs.writeFile(join(previousDirectory, "model.gguf"), "cached model");

    await expect(migrateModelDirectory(previousDirectory, modelDirectory)).resolves.toBe(true);
    await expect(fs.readFile(join(modelDirectory, "model.gguf"), "utf8")).resolves.toBe(
      "cached model",
    );
    await expect(migrateModelDirectory(previousDirectory, modelDirectory)).resolves.toBe(false);
  });
});
