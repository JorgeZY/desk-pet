export type ModelMode = "huggingface" | "local";

export type WindowMode = "pet" | "chat" | "settings" | "onboarding";

export interface RuntimeConfig {
  setupComplete: boolean;
  executable: string;
  modelMode: ModelMode;
  hfRepo: string;
  modelPath: string;
  host: "127.0.0.1";
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  maxTokens: number;
  temperature: number;
  autoStart: boolean;
  systemPrompt: string;
}

export type RuntimePhase =
  | "stopped"
  | "starting"
  | "downloading"
  | "ready"
  | "stopping"
  | "error";

export type ModelDownloadSource = "modelscope" | "huggingface";

export interface ModelDownloadProgress {
  source: ModelDownloadSource;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface RuntimeState {
  phase: RuntimePhase;
  pid?: number;
  endpoint: string;
  message: string;
  lastLog?: string;
  error?: string;
  download?: ModelDownloadProgress;
  externallyManaged?: boolean;
  updatedAt: number;
}

export interface BootstrapData {
  config: RuntimeConfig;
  runtime: RuntimeState;
  platform: string;
  appVersion: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  createdAt: number;
}

export interface ChatRequest {
  requestId: string;
  messages: ChatMessage[];
  thinking: boolean;
}

export type ChatEvent =
  | { requestId: string; type: "start" }
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "reasoning"; text: string }
  | { requestId: string; type: "done"; timings?: Record<string, unknown> }
  | { requestId: string; type: "error"; message: string };

export interface ProbeResult {
  ok: boolean;
  executable: string;
  version?: string;
  error?: string;
}

export interface FilePickResult {
  path: string;
  name: string;
}

export interface DesktopPetApi {
  getBootstrap(): Promise<BootstrapData>;
  saveConfig(config: RuntimeConfig): Promise<BootstrapData>;
  probeRuntime(executable?: string): Promise<ProbeResult>;
  startRuntime(): Promise<RuntimeState>;
  stopRuntime(): Promise<RuntimeState>;
  restartRuntime(): Promise<RuntimeState>;
  pickExecutable(): Promise<FilePickResult | null>;
  pickModel(): Promise<FilePickResult | null>;
  setWindowMode(mode: WindowMode): Promise<void>;
  hideWindow(): Promise<void>;
  openExternal(url: string): Promise<void>;
  startChat(request: ChatRequest): void;
  abortChat(requestId: string): void;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  onRuntimeState(listener: (state: RuntimeState) => void): () => void;
  onOpenView(listener: (mode: WindowMode) => void): () => void;
}
