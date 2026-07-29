import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatEvent,
  ChatRequest,
  DesktopPetApi,
  RuntimeConfig,
  RuntimeState,
  WindowMode,
} from "../shared/types";

const api: DesktopPetApi = {
  getBootstrap: () => ipcRenderer.invoke("desktop-pet:get-bootstrap"),
  saveConfig: (config: RuntimeConfig) => ipcRenderer.invoke("desktop-pet:save-config", config),
  probeRuntime: (executable?: string) => ipcRenderer.invoke("runtime:probe", executable),
  startRuntime: () => ipcRenderer.invoke("runtime:start"),
  stopRuntime: () => ipcRenderer.invoke("runtime:stop"),
  restartRuntime: () => ipcRenderer.invoke("runtime:restart"),
  pickExecutable: () => ipcRenderer.invoke("dialog:pick-executable"),
  pickModel: () => ipcRenderer.invoke("dialog:pick-model"),
  setWindowMode: (mode: WindowMode) => ipcRenderer.invoke("window:set-mode", mode),
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
  onOpenView: (listener: (mode: WindowMode) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, mode: WindowMode): void => listener(mode);
    ipcRenderer.on("app:open-view", wrapped);
    return () => ipcRenderer.removeListener("app:open-view", wrapped);
  },
};

contextBridge.exposeInMainWorld("desktopPet", api);
