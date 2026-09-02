import { basename, win32 } from "node:path";
import type { RuntimeConfig } from "../shared/types";
import {
  effectiveRequiredModelParameter,
  modelParameterEnabled,
} from "../shared/model-parameters";
import { LLAMA_CPP_MODEL_ALIAS } from "./agent/llama-model-adapter";

export interface LlamaCommand {
  command: string;
  args: string[];
}

export const LLAMA_CPP_EMBEDDING_MODEL_ALIAS = "desk-pet-embedding";

export function embeddingModelAlias(modelSha256: string): string {
  const digest = modelSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Embedding 模型 SHA-256 无效。");
  }
  return `${LLAMA_CPP_EMBEDDING_MODEL_ALIAS}-${digest.slice(0, 16)}`;
}

function llamaServeArgs(executable: string): string[] {
  const fileNames = [basename(executable), win32.basename(executable)]
    .map((fileName) => fileName.toLowerCase());
  return fileNames.some((fileName) => fileName === "llama" || fileName === "llama.exe")
    ? ["serve"]
    : [];
}

export function buildLlamaCommand(config: RuntimeConfig): LlamaCommand {
  const executable = config.executable.trim();
  const args = llamaServeArgs(executable);

  if (config.modelMode === "huggingface") args.push("-hf", config.hfRepo);
  else args.push("-m", config.modelPath);
  if (config.mmprojPath) args.push("--mmproj", config.mmprojPath);

  args.push(
    "--host", config.host,
    "--port", String(effectiveRequiredModelParameter(config, "port")),
    "-c", String(effectiveRequiredModelParameter(config, "contextSize")),
    "-np", "1",
    "--alias", LLAMA_CPP_MODEL_ALIAS,
    "--jinja",
    "--tools", "all",
    "--cors-origins", "localhost",
  );
  if (modelParameterEnabled(config, "gpuLayers")) {
    args.push("-ngl", String(config.gpuLayers));
  }
  if (modelParameterEnabled(config, "threads")) {
    args.push("-t", String(config.threads));
  }
  return { command: executable, args };
}

export function buildEmbeddingLlamaCommand(
  config: RuntimeConfig,
  resolvedModelPath?: string,
  modelAlias = LLAMA_CPP_EMBEDDING_MODEL_ALIAS,
): LlamaCommand {
  const executable = config.executable.trim();
  const args = llamaServeArgs(executable);
  const embedding = config.embedding;
  const localPath = resolvedModelPath?.trim();

  if (localPath) args.push("-m", localPath);
  else if (embedding.modelMode === "huggingface") args.push("-hf", embedding.hfRepo);
  else args.push("-m", embedding.modelPath);

  args.push(
    "--host", config.host,
    "--port", String(embedding.port),
    "-c", String(embedding.contextSize),
    "-b", "2048",
    "-ub", "512",
    "-np", "1",
    "--alias", modelAlias,
    "--embedding",
    "--pooling", "last",
    "--embd-normalize", "2",
    "-ngl", String(embedding.gpuLayers),
    "-t", String(embedding.threads),
    "--no-webui",
    "--cors-origins", "localhost",
  );
  return { command: executable, args };
}
