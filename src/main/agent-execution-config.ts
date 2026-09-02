import type { RuntimeConfig } from "../shared/types";

function executionConfig(config: RuntimeConfig): unknown {
  return {
    executable: config.executable,
    modelMode: config.modelMode,
    hfRepo: config.hfRepo,
    modelPath: config.modelPath,
    mmprojPath: config.mmprojPath,
    mcpServersConfigPath: config.mcpServersConfigPath,
    toolSettings: config.toolSettings,
    embedding: config.embedding,
    modelParameterOverrides: config.modelParameterOverrides,
    host: config.host,
    port: config.port,
    contextSize: config.contextSize,
    gpuLayers: config.gpuLayers,
    threads: config.threads,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    topK: config.topK,
    topP: config.topP,
    minP: config.minP,
    repeatPenalty: config.repeatPenalty,
    presencePenalty: config.presencePenalty,
    systemPrompt: config.systemPrompt,
  };
}

export function agentExecutionConfigChanged(
  previous: RuntimeConfig,
  next: RuntimeConfig,
): boolean {
  return JSON.stringify(executionConfig(previous)) !== JSON.stringify(executionConfig(next));
}
