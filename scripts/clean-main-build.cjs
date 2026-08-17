const { rmSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const workspaceRoot = resolve(__dirname, "..");
const outputDirectory = resolve(workspaceRoot, "dist-electron");

if (dirname(outputDirectory) !== workspaceRoot) {
  throw new Error(`Refusing to clean unexpected build directory: ${outputDirectory}`);
}

rmSync(outputDirectory, { recursive: true, force: true });
