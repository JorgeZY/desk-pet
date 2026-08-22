export interface CaptionWorkerConfig {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  featureDim: number;
  threads: number;
}

export type CaptionWorkerRequest =
  | { type: "initialize"; config: CaptionWorkerConfig }
  | { type: "audio"; inputSampleRate: number; samples: Float32Array }
  | { type: "stop" };

export type CaptionWorkerEvent =
  | { type: "ready" }
  | { type: "partial"; text: string; startMs: number; endMs: number }
  | { type: "segment"; text: string; startMs: number; endMs: number }
  | { type: "stopped" }
  | { type: "error"; message: string };
