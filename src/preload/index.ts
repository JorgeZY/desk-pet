import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatEvent,
  ChatRequest,
  DesktopPetApi,
  RuntimeConfig,
  RuntimeState,
  SpeechEvent,
  SpeechState,
  TtsState,
  WindowMode,
} from "../shared/types";

const api: DesktopPetApi = {
  getBootstrap: () => ipcRenderer.invoke("desktop-pet:get-bootstrap"),
  saveConfig: (config: RuntimeConfig) => ipcRenderer.invoke("desktop-pet:save-config", config),
  probeRuntime: (executable?: string) => ipcRenderer.invoke("runtime:probe", executable),
  startRuntime: () => ipcRenderer.invoke("runtime:start"),
  stopRuntime: () => ipcRenderer.invoke("runtime:stop"),
  restartRuntime: () => ipcRenderer.invoke("runtime:restart"),
  prepareSpeech: (force?: boolean) => ipcRenderer.invoke("speech:prepare", force),
  importSpeechModels: () => ipcRenderer.invoke("speech:import"),
  startSpeech: () => ipcRenderer.invoke("speech:start"),
  stopSpeech: (sessionId: string) => ipcRenderer.invoke("speech:stop", sessionId),
  cancelSpeech: (sessionId: string) => ipcRenderer.invoke("speech:cancel", sessionId),
  setSpeechComposerFocused: (focused: boolean) => ipcRenderer.send("speech:composer-focus", focused),
  prepareTts: (force?: boolean) => ipcRenderer.invoke("tts:prepare", force),
  importTtsModels: () => ipcRenderer.invoke("tts:import"),
  speakText: (text: string) => ipcRenderer.invoke("tts:speak", text),
  stopSpeaking: () => ipcRenderer.invoke("tts:stop"),
  pickExecutable: () => ipcRenderer.invoke("dialog:pick-executable"),
  pickModel: () => ipcRenderer.invoke("dialog:pick-model"),
  pickMmproj: () => ipcRenderer.invoke("dialog:pick-mmproj"),
  pickMcpServersConfig: () => ipcRenderer.invoke("dialog:pick-mcp-servers-config"),
  listRuntimeTools: () => ipcRenderer.invoke("runtime:list-tools"),
  pickChatImages: () => ipcRenderer.invoke("dialog:pick-chat-images"),
  pickChatDocuments: () => ipcRenderer.invoke("dialog:pick-chat-documents"),
  listChatConversations: () => ipcRenderer.invoke("chat-history:list"),
  createChatConversation: () => ipcRenderer.invoke("chat-history:create"),
  loadChatConversation: (conversationId: string) =>
    ipcRenderer.invoke("chat-history:load", conversationId),
  saveChatMessages: (conversationId: string, messages) =>
    ipcRenderer.invoke("chat-history:save", conversationId, messages),
  deleteChatConversation: (conversationId: string) =>
    ipcRenderer.invoke("chat-history:delete", conversationId),
  setWindowMode: (mode: WindowMode) => ipcRenderer.invoke("window:set-mode", mode),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  startChat: (request: ChatRequest) => ipcRenderer.send("chat:start", request),
  abortChat: (requestId: string) => ipcRenderer.send("chat:abort", requestId),
  resolveToolApproval: (requestId: string, toolCallId: string, approved: boolean) =>
    ipcRenderer.send("chat:tool-approval", { requestId, toolCallId, approved }),
  onChatEvent: (listener: (event: ChatEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatEvent): void => listener(payload);
    ipcRenderer.on("chat:event", wrapped);
    return () => ipcRenderer.removeListener("chat:event", wrapped);
  },
  onRuntimeState: (listener: (state: RuntimeState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeState): void =>
      listener(payload);
    ipcRenderer.on("runtime:state", wrapped);
    return () => ipcRenderer.removeListener("runtime:state", wrapped);
  },
  onSpeechState: (listener: (state: SpeechState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: SpeechState): void =>
      listener(payload);
    ipcRenderer.on("speech:state", wrapped);
    return () => ipcRenderer.removeListener("speech:state", wrapped);
  },
  onSpeechEvent: (listener: (event: SpeechEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: SpeechEvent): void =>
      listener(payload);
    ipcRenderer.on("speech:event", wrapped);
    return () => ipcRenderer.removeListener("speech:event", wrapped);
  },
  onTtsState: (listener: (state: TtsState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TtsState): void =>
      listener(payload);
    ipcRenderer.on("tts:state", wrapped);
    return () => ipcRenderer.removeListener("tts:state", wrapped);
  },
  onOpenView: (listener: (mode: WindowMode) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, mode: WindowMode): void => listener(mode);
    ipcRenderer.on("app:open-view", wrapped);
    return () => ipcRenderer.removeListener("app:open-view", wrapped);
  },
};

contextBridge.exposeInMainWorld("desktopPet", api);
