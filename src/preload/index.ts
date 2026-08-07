import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatEvent,
  ChatRequest,
  DesktopPetApi,
  RuntimeConfig,
  RuntimeState,
  SpeechEvent,
  SpeechState,
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
  pickExecutable: () => ipcRenderer.invoke("dialog:pick-executable"),
  pickModel: () => ipcRenderer.invoke("dialog:pick-model"),
  pickMmproj: () => ipcRenderer.invoke("dialog:pick-mmproj"),
  pickChatImages: () => ipcRenderer.invoke("dialog:pick-chat-images"),
  setWindowMode: (mode: WindowMode) => ipcRenderer.invoke("window:set-mode", mode),
  setPetWindowHeight: (height: number) => ipcRenderer.invoke("window:set-pet-height", height),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  startChat: (request: ChatRequest) => ipcRenderer.send("chat:start", request),
  abortChat: (requestId: string) => ipcRenderer.send("chat:abort", requestId),
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
  onOpenView: (listener: (mode: WindowMode) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, mode: WindowMode): void => listener(mode);
    ipcRenderer.on("app:open-view", wrapped);
    return () => ipcRenderer.removeListener("app:open-view", wrapped);
  },
};

contextBridge.exposeInMainWorld("desktopPet", api);
