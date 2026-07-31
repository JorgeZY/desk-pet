import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ModelDirectoryOptions {
  appPath: string;
  executablePath: string;
  isPackaged: boolean;
  override?: string;
}

export function resolveModelDirectory(options: ModelDirectoryOptions): string {
  const override = options.override?.trim();
  if (override) return resolve(override);

  const applicationRoot = options.isPackaged
    ? dirname(options.executablePath)
    : options.appPath;
  return join(applicationRoot, "models");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function migrateModelDirectory(
  previousDirectory: string,
  modelDirectory: string,
): Promise<boolean> {
  if (resolve(previousDirectory) === resolve(modelDirectory)) return false;
  if (!(await pathExists(previousDirectory)) || (await pathExists(modelDirectory))) return false;

  await fs.mkdir(dirname(modelDirectory), { recursive: true });
  await fs.cp(previousDirectory, modelDirectory, { recursive: true });
  return true;
}
