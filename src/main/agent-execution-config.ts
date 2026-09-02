import type { RuntimeConfig } from "../shared/types";

function executionConfig(config: RuntimeConfig): Omit<
  RuntimeConfig,
  "setupComplete" | "speech" | "tts" | "caption"
> {
  const {
    setupComplete: _setupComplete,
    speech: _speech,
    tts: _tts,
    caption: _caption,
    ...executionSettings
  } = config;
  return executionSettings;
}

export function agentExecutionConfigChanged(
  previous: RuntimeConfig,
  next: RuntimeConfig,
): boolean {
  return JSON.stringify(executionConfig(previous)) !== JSON.stringify(executionConfig(next));
}
