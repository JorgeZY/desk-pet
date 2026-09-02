import type { RuntimeConfig } from "./types";

export const MODEL_PARAMETER_KEYS = [
  "contextSize",
  "gpuLayers",
  "threads",
  "maxTokens",
  "temperature",
  "port",
  "topK",
  "topP",
  "minP",
  "repeatPenalty",
  "presencePenalty",
] as const;

export type ModelParameterKey = typeof MODEL_PARAMETER_KEYS[number];
export type ModelParameterOverrides = Record<ModelParameterKey, boolean>;

export const DEFAULT_MODEL_PARAMETER_OVERRIDES: ModelParameterOverrides = {
  contextSize: true,
  gpuLayers: true,
  threads: true,
  maxTokens: true,
  temperature: true,
  port: true,
  topK: true,
  topP: true,
  minP: true,
  repeatPenalty: true,
  presencePenalty: true,
};

export const REQUIRED_MODEL_PARAMETER_DEFAULTS = {
  contextSize: 8192,
  maxTokens: 512,
  port: 18766,
} as const;

export function modelParameterEnabled(
  config: Pick<RuntimeConfig, "modelParameterOverrides">,
  key: ModelParameterKey,
): boolean {
  return config.modelParameterOverrides[key];
}

export function effectiveRequiredModelParameter<
  K extends keyof typeof REQUIRED_MODEL_PARAMETER_DEFAULTS,
>(config: RuntimeConfig, key: K): RuntimeConfig[K] {
  return (modelParameterEnabled(config, key)
    ? config[key]
    : REQUIRED_MODEL_PARAMETER_DEFAULTS[key]) as RuntimeConfig[K];
}
