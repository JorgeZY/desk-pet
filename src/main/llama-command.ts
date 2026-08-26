import { basename, win32 } from "node:path";
import type { RuntimeConfig } from "../shared/types";
import { LLAMA_CPP_MODEL_ALIAS } from "./agent/llama-model-adapter";

export interface LlamaCommand {
  command: string;
  args: string[];
}

export function buildLlamaCommand(config: RuntimeConfig): LlamaCommand {
  const executable = config.executable.trim();
  const fileName = win32.basename(executable).toLowerCase() || basename(executable).toLowerCase();
  const args: string[] = fileName === "llama" || fileName === "llama.exe" ? ["serve"] : [];

  if (config.modelMode === "huggingface") args.push("-hf", config.hfRepo);
  else args.push("-m", config.modelPath);
  if (config.mmprojPath) args.push("--mmproj", config.mmprojPath);

  args.push(
    "--host", config.host,
    "--port", String(config.port),
    "-c", String(config.contextSize),
    "-ngl", String(config.gpuLayers),
    "-t", String(config.threads),
    "-np", "1",
    "--alias", LLAMA_CPP_MODEL_ALIAS,
    "--jinja",
    "--tools", "all",
    "--cors-origins", "localhost",
  );
  return { command: executable, args };
}
