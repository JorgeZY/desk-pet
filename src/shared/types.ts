import type { ModelParameterOverrides } from "./model-parameters";

export type ModelMode = "huggingface" | "local";

export type WindowMode = "pet" | "chat" | "tasks" | "settings" | "onboarding";

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowBounds extends WindowPosition {
  width: number;
  height: number;
}

export interface WindowUiState {
  layoutVersion: 1;
  petPosition?: WindowPosition;
  workbenchBounds?: WindowBounds;
  workbenchMaximized: boolean;
  sidebarCollapsed: boolean;
}

export interface WorkbenchWindowSnapshot {
  maximized: boolean;
  sidebarCollapsed: boolean;
}

export interface CaptionWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptionConfig {
  layoutVersion: 3;
  fontSize: number;
  opacity: number;
  bounds?: CaptionWindowBounds;
}

export interface SpeechConfig {
  enabled: boolean;
  shortcut: "F8";
  threads: number;
  language: "auto";
  modelDirectory: string;
}

export interface TtsConfig {
  enabled: boolean;
  speed: number;
  speaker: number;
  modelDirectory: string;
}

export interface ToolSettingsConfig {
  builtinEnabled: boolean;
  mcpEnabled: boolean;
  knowledgeEnabled: boolean;
  tasksEnabled: boolean;
  disabledToolIds: string[];
}

export interface EmbeddingConfig {
  enabled: boolean;
  modelMode: ModelMode;
  hfRepo: string;
  modelPath: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
}

export interface RuntimeConfig {
  setupComplete: boolean;
  executable: string;
  modelMode: ModelMode;
  hfRepo: string;
  modelPath: string;
  mmprojPath: string;
  mcpServersConfigPath: string;
  toolSettings: ToolSettingsConfig;
  embedding: EmbeddingConfig;
  modelParameterOverrides: ModelParameterOverrides;
  host: "127.0.0.1";
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  maxTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  presencePenalty: number;
  autoStart: boolean;
  chatTemplates: string[];
  systemPrompt: string;
  speech: SpeechConfig;
  tts: TtsConfig;
  caption: CaptionConfig;
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
  visionEnabled: boolean;
  pid?: number;
  endpoint: string;
  message: string;
  lastLog?: string;
  error?: string;
  download?: ModelDownloadProgress;
  externallyManaged?: boolean;
  updatedAt: number;
}

export type SpeechPhase =
  | "not-installed"
  | "downloading"
  | "loading"
  | "ready"
  | "recording"
  | "transcribing"
  | "error";

export type SpeechModelId = "streaming-paraformer" | "sense-voice";

export interface SpeechDownloadProgress {
  model: SpeechModelId;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface SpeechState {
  enabled: boolean;
  phase: SpeechPhase;
  message: string;
  modelDirectory: string;
  inputDevice?: string;
  activeSessionId?: string;
  level?: number;
  progress?: SpeechDownloadProgress;
  error?: string;
  updatedAt: number;
}

export type SpeechSessionSource = "button" | "shortcut";

export type TtsPhase =
  | "not-installed"
  | "downloading"
  | "loading"
  | "ready"
  | "speaking"
  | "error";

export interface TtsDownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface TtsState {
  enabled: boolean;
  phase: TtsPhase;
  message: string;
  modelDirectory: string;
  speakingRequestId?: string;
  progress?: TtsDownloadProgress;
  error?: string;
  updatedAt: number;
}

export type SpeechEvent =
  | { type: "setup-required" }
  | { type: "started"; sessionId: string; source: SpeechSessionSource }
  | { type: "partial"; sessionId: string; text: string }
  | { type: "final"; sessionId: string; text: string }
  | { type: "inserted"; sessionId: string; text: string }
  | { type: "insertion-error"; sessionId: string; message: string }
  | { type: "cancelled"; sessionId: string; message: string }
  | { type: "error"; sessionId?: string; message: string };

export interface SpeechStartResult {
  sessionId: string;
}

export type CaptionPhase =
  | "not-installed"
  | "downloading"
  | "loading"
  | "ready"
  | "capturing"
  | "error";

export interface CaptionSegment {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionDownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export interface CaptionState {
  phase: CaptionPhase;
  message: string;
  modelDirectory: string;
  sessionId?: string;
  partial: string;
  segments: CaptionSegment[];
  inputAudioMs?: number;
  inputLevel?: number;
  progress?: CaptionDownloadProgress;
  error?: string;
  updatedAt: number;
}

export type CaptionEvent =
  | { type: "setup-required" }
  | { type: "started"; sessionId: string }
  | { type: "partial"; sessionId: string; text: string }
  | { type: "segment"; sessionId: string; segment: CaptionSegment }
  | { type: "stopped"; sessionId?: string; message: string }
  | { type: "error"; sessionId?: string; message: string };

export interface BootstrapData {
  config: RuntimeConfig;
  runtime: RuntimeState;
  embedding: EmbeddingState;
  speech: SpeechState;
  tts: TtsState;
  caption: CaptionState;
  platform: string;
  appVersion: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * Ordered renderer parts used to restore interleaved text, reasoning,
   * attachments, and tool activity. Older history rows omit this field and
   * continue to use the flattened fields below.
   */
  parts?: ChatMessagePart[];
  images?: ChatImage[];
  documents?: ChatDocument[];
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  contextUsage?: ChatContextUsage;
  createdAt: number;
}

export interface ChatContextUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type ChatImageMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface ChatImage {
  path: string;
  name: string;
  mimeType: ChatImageMimeType;
  previewUrl?: string;
}

export type ChatDocumentMimeType = "text/plain" | "application/pdf";

export interface ChatDocument {
  path: string;
  name: string;
  mimeType: ChatDocumentMimeType;
  text: string;
  characterCount: number;
  truncated?: boolean;
}

export interface KnowledgeDocumentSummary {
  id: string;
  path: string;
  name: string;
  mimeType: ChatDocumentMimeType;
  characterCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export type EmbeddingPhase =
  | "not-installed"
  | "stopped"
  | "starting"
  | "downloading"
  | "indexing"
  | "ready"
  | "stopping"
  | "error";

export interface EmbeddingState {
  enabled: boolean;
  phase: EmbeddingPhase;
  endpoint: string;
  modelPath: string;
  message: string;
  pid?: number;
  indexedChunkCount: number;
  pendingChunkCount: number;
  embeddingDimension?: number;
  download?: ModelDownloadProgress;
  error?: string;
  lastLog?: string;
  updatedAt: number;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  documentName: string;
  position: number;
  score: number;
  text: string;
}

export type LongTaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting-approval"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type LongTaskStepStatus =
  | "pending"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export interface LongTaskStepInput {
  title: string;
  instruction: string;
}

export interface LongTaskCreateInput {
  title: string;
  objective: string;
  steps: LongTaskStepInput[];
}

export interface LongTaskStep extends LongTaskStepInput {
  id: string;
  position: number;
  status: LongTaskStepStatus;
  attemptCount: number;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface LongTask {
  id: string;
  title: string;
  objective: string;
  status: LongTaskStatus;
  currentStep: number;
  steps: LongTaskStep[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  pendingApproval?: {
    requestId: string;
    stepId: string;
    call: ChatToolCall;
  };
}

export type LongTaskEvent =
  | { type: "task-updated"; task: LongTask }
  | { type: "task-deleted"; taskId: string }
  | { type: "chat-event"; taskId: string; stepId: string; event: ChatEvent };

export type ThinkingEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ChatToolCallStatus =
  | "pending-approval"
  | "running"
  | "completed"
  | "denied"
  | "error";

export interface ChatToolCall {
  id: string;
  name: string;
  displayName: string;
  arguments: string;
  status: ChatToolCallStatus;
  requiresApproval: boolean;
  result?: string;
  error?: string;
}

export interface ChatMessageToolResultPart {
  toolCallId: string;
  status: Extract<ChatToolCallStatus, "completed" | "denied" | "error">;
  resultPresent: boolean;
  errorPresent: boolean;
  result?: string;
  error?: string;
}

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "data-image-attachment"; data: ChatImage }
  | { type: "data-document-attachment"; data: ChatDocument }
  | { type: "dynamic-tool"; call: ChatToolCall }
  | { type: "data-tool-result"; data: ChatMessageToolResultPart };

export interface ChatToolDefinition {
  id: string;
  displayName: string;
  source: "builtin" | "mcp" | "knowledge" | "task";
  requiresApproval: boolean;
}

export interface ChatRequest {
  requestId: string;
  messages: ChatMessage[];
  thinking: boolean;
  thinkingEffort: ThinkingEffort;
}

export type ChatEvent =
  | { requestId: string; type: "start" }
  | { requestId: string; type: "warning"; message: string }
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "reasoning"; text: string }
  | { requestId: string; type: "tool-call"; call: ChatToolCall }
  | {
      requestId: string;
      type: "tool-result";
      toolCallId: string;
      status: Extract<ChatToolCallStatus, "completed" | "denied" | "error">;
      result?: string;
      error?: string;
    }
  | {
      requestId: string;
      type: "done";
      finishReason?: string;
      timings?: Record<string, unknown>;
      contextUsage?: ChatContextUsage;
    }
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
  startEmbedding(): Promise<EmbeddingState>;
  prepareEmbedding(force?: boolean): Promise<EmbeddingState>;
  stopEmbedding(): Promise<EmbeddingState>;
  reindexKnowledge(): Promise<EmbeddingState>;
  listLongTasks(): Promise<LongTask[]>;
  createLongTask(input: LongTaskCreateInput): Promise<LongTask>;
  startLongTask(taskId: string): Promise<LongTask>;
  pauseLongTask(taskId: string): Promise<LongTask>;
  cancelLongTask(taskId: string): Promise<LongTask>;
  deleteLongTask(taskId: string): Promise<void>;
  resolveLongTaskApproval(
    taskId: string,
    requestId: string,
    toolCallId: string,
    approved: boolean,
  ): void;
  prepareSpeech(force?: boolean): Promise<SpeechState>;
  importSpeechModels(): Promise<SpeechState | null>;
  startSpeech(): Promise<SpeechStartResult | null>;
  stopSpeech(sessionId: string): Promise<SpeechState>;
  cancelSpeech(sessionId: string): Promise<SpeechState>;
  setSpeechComposerFocused(focused: boolean): void;
  prepareTts(force?: boolean): Promise<TtsState>;
  importTtsModels(): Promise<TtsState | null>;
  speakText(text: string): Promise<TtsState>;
  stopSpeaking(): Promise<TtsState>;
  openCaptionWindow(): Promise<CaptionState>;
  closeCaptionWindow(): Promise<void>;
  prepareCaption(force?: boolean): Promise<CaptionState>;
  startLiveCaption(): Promise<CaptionState>;
  stopLiveCaption(): Promise<CaptionState>;
  clearCaptionHistory(): Promise<CaptionState>;
  updateCaptionConfig(config: CaptionConfig): Promise<CaptionConfig>;
  notifyCaptionCaptureEnded(message: string): void;
  pickExecutable(): Promise<FilePickResult | null>;
  pickModel(): Promise<FilePickResult | null>;
  pickEmbeddingModel(): Promise<FilePickResult | null>;
  pickMmproj(): Promise<FilePickResult | null>;
  pickMcpServersConfig(): Promise<FilePickResult | null>;
  listRuntimeTools(): Promise<ChatToolDefinition[]>;
  pickChatImages(): Promise<ChatImage[]>;
  pickChatDocuments(): Promise<ChatDocument[]>;
  listKnowledgeDocuments(): Promise<KnowledgeDocumentSummary[]>;
  importKnowledgeDocuments(): Promise<KnowledgeDocumentSummary[] | null>;
  deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentSummary[]>;
  listChatConversations(): Promise<ChatConversation[]>;
  createChatConversation(): Promise<ChatConversation>;
  loadChatConversation(conversationId: string): Promise<ChatMessage[]>;
  saveChatMessages(conversationId: string, messages: ChatMessage[]): Promise<ChatConversation>;
  deleteChatConversation(conversationId: string): Promise<void>;
  deleteChatConversations(conversationIds: string[]): Promise<void>;
  setWindowMode(mode: WindowMode): Promise<void>;
  hideWindow(): Promise<void>;
  minimizeWorkbench(): Promise<void>;
  toggleMaximizeWorkbench(): Promise<WorkbenchWindowSnapshot>;
  getWorkbenchWindowState(): Promise<WorkbenchWindowSnapshot>;
  setSidebarCollapsed(collapsed: boolean): Promise<WorkbenchWindowSnapshot>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  startChat(request: ChatRequest): void;
  abortChat(requestId: string): void;
  resolveToolApproval(requestId: string, toolCallId: string, approved: boolean): void;
  onPrepareQuit(listener: (token: string) => void): () => void;
  acknowledgeQuitPreparation(
    token: string,
    result: { ok: boolean; error?: string },
  ): void;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  onBootstrap(listener: (data: BootstrapData) => void): () => void;
  onRuntimeState(listener: (state: RuntimeState) => void): () => void;
  onEmbeddingState(listener: (state: EmbeddingState) => void): () => void;
  onLongTaskEvent(listener: (event: LongTaskEvent) => void): () => void;
  onSpeechState(listener: (state: SpeechState) => void): () => void;
  onSpeechEvent(listener: (event: SpeechEvent) => void): () => void;
  onTtsState(listener: (state: TtsState) => void): () => void;
  onCaptionState(listener: (state: CaptionState) => void): () => void;
  onCaptionEvent(listener: (event: CaptionEvent) => void): () => void;
  onCaptionConfig(listener: (config: CaptionConfig) => void): () => void;
  onOpenView(listener: (mode: WindowMode) => void): () => void;
  onWorkbenchWindowState(listener: (state: WorkbenchWindowSnapshot) => void): () => void;
  notifyViewReady(mode: WindowMode): void;
}
