import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  MessageChannelMain,
  Menu,
  nativeImage,
  net,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { basename, extname, join } from "node:path";
import type {
  BootstrapData,
  CaptionConfig,
  CaptionEvent,
  CaptionState,
  ChatDocument,
  ChatMessage,
  ChatImage,
  ChatImageMimeType,
  ChatRequest,
  FilePickResult,
  ProbeResult,
  RuntimeConfig,
  SpeechEvent,
  SpeechState,
  TtsState,
  WindowMode,
} from "../shared/types";
import {
  CAPTION_WINDOW_DEFAULTS,
  clampCaptionBounds,
  defaultCaptionBounds,
  normalizeCaptionConfig,
} from "../shared/caption-window";
import {
  clampWindowPosition,
  PET_WINDOW_BASE_HEIGHT,
  PET_WINDOW_WIDTH,
} from "../shared/pet-window";
import { ConfigStore } from "./config-store";
import { ChatHistoryStore } from "./chat-history-store";
import {
  CHAT_TEXT_EXTENSIONS,
  MAX_CHAT_DOCUMENTS,
  MAX_CHAT_DOCUMENT_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS,
  readChatDocument,
} from "./chat-documents";
import { pasteDictationText, resolveShortcutSpeechSource } from "./global-dictation";
import { AudioModeCoordinator } from "./audio-mode-coordinator";
import { LlamaRuntime } from "./llama-runtime";
import { LiveCaptionRuntime } from "./live-caption-runtime";
import { migrateModelDirectory, resolveModelDirectory } from "./model-directory";
import { validateMcpServersConfigContents } from "./mcp-servers-config";
import { ManagedModelDownloader } from "./model-downloader";
import { SpeechModelManager } from "./speech-model-manager";
import { SpeechRuntime } from "./speech-runtime";
import { TtsModelManager } from "./tts-model-manager";
import { TtsRuntime } from "./tts-runtime";

const execFileAsync = promisify(execFile);
app.setName("desk-pet");

const WINDOW_SIZES: Record<WindowMode, { width: number; height: number }> = {
  pet: { width: PET_WINDOW_WIDTH, height: PET_WINDOW_BASE_HEIGHT },
  chat: { width: 440, height: 700 },
  settings: { width: 560, height: 740 },
  onboarding: { width: 560, height: 740 },
};
let mainWindow: BrowserWindow | null = null;
let captionWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let configStore: ConfigStore;
let chatHistoryStore: ChatHistoryStore | null = null;
let config: RuntimeConfig;
let runtime: LlamaRuntime;
let speech: SpeechRuntime;
let tts: TtsRuntime;
let caption: LiveCaptionRuntime;
let audioModes: AudioModeCoordinator;
let currentWindowMode: WindowMode = "pet";
let shortcutHook: typeof import("uiohook-napi").uIOhook | undefined;
let shortcutHookStarted = false;
let shortcutListenersRegistered = false;
let shortcutPressed = false;
let shortcutReleasedBeforeStart = false;
let shortcutSessionId: string | undefined;
let speechComposerFocused = false;
let petWindowPosition: { x: number; y: number } | null = null;
const globalDictationSessions = new Set<string>();
let captionAudioPort: Electron.MessagePortMain | null = null;
let captionBoundsSaveTimer: NodeJS.Timeout | undefined;
let configWriteQueue: Promise<void> = Promise.resolve();

function updateStoredConfig(
  mutate: (current: RuntimeConfig) => RuntimeConfig,
): Promise<RuntimeConfig> {
  const task = configWriteQueue.then(async () => {
    config = await configStore.write(mutate(config));
    return config;
  });
  configWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

function assetPath(fileName: string): string {
  return join(__dirname, "../../assets", fileName);
}

function rendererUrl(view?: string): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const url = new URL(devUrl ?? `file://${join(__dirname, "../../dist-renderer/index.html")}`);
  const requestedView = view ?? process.env.DESK_PET_CAPTURE_VIEW;
  if (requestedView) url.searchParams.set("view", requestedView);
  return url.toString();
}

function requestedWindowMode(): WindowMode | undefined {
  const value = process.env.DESK_PET_CAPTURE_VIEW;
  return value === "pet" || value === "chat" || value === "settings" || value === "onboarding"
    ? value
    : undefined;
}

function anchorWindow(window: BrowserWindow, width: number, height: number): void {
  const previous = window.getBounds();
  const display = screen.getDisplayMatching(previous);
  const { workArea } = display;
  const margin = 18;
  const wasNearRight = Math.abs(previous.x + previous.width - workArea.x - workArea.width) < 100;
  const wasNearBottom = Math.abs(previous.y + previous.height - workArea.y - workArea.height) < 100;
  const x = wasNearRight
    ? workArea.x + workArea.width - width - margin
    : Math.min(Math.max(previous.x, workArea.x), workArea.x + workArea.width - width);
  const y = wasNearBottom
    ? workArea.y + workArea.height - height - margin
    : Math.min(Math.max(previous.y, workArea.y), workArea.y + workArea.height - height);
  // Renderer fades out before changing modes, so resize once instead of exposing
  // Windows' uneven transparent-window animation between the two layouts.
  window.setBounds({ x, y, width, height }, false);
}

function restorePetWindow(window: BrowserWindow, width: number, height: number): void {
  if (!petWindowPosition) {
    anchorWindow(window, width, height);
    return;
  }

  const display = screen.getDisplayNearestPoint(petWindowPosition);
  const position = clampWindowPosition(petWindowPosition, { width, height }, display.workArea);
  window.setBounds({ ...position, width, height }, false);
}

function setWindowMode(mode: WindowMode): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const previousMode = currentWindowMode;
  if (previousMode === "pet" && mode !== "pet") {
    const bounds = mainWindow.getBounds();
    petWindowPosition = { x: bounds.x, y: bounds.y };
  }

  currentWindowMode = mode;
  const size = WINDOW_SIZES[mode];
  if (mode === "pet" && previousMode !== "pet") {
    restorePetWindow(mainWindow, size.width, size.height);
  } else {
    anchorWindow(mainWindow, size.width, size.height);
  }
}

function showWindow(mode?: WindowMode): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode) setWindowMode(mode);
  mainWindow.show();
  mainWindow.moveTop();
}

function openWindowMode(mode: WindowMode): void {
  const nextMode = config.setupComplete ? mode : "onboarding";
  showWindow(nextMode);
  mainWindow?.webContents.send("app:open-view", nextMode);
}

function createMainWindow(): BrowserWindow {
  const captureCaption = process.env.DESK_PET_CAPTURE_VIEW === "caption";
  const mode: WindowMode = requestedWindowMode() ?? (config.setupComplete ? "pet" : "onboarding");
  currentWindowMode = mode;
  const size = captureCaption
    ? { width: CAPTION_WINDOW_DEFAULTS.width, height: CAPTION_WINDOW_DEFAULTS.height }
    : WINDOW_SIZES[mode];
  const { workArea } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: workArea.x + workArea.width - size.width - 18,
    y: workArea.y + workArea.height - size.height - 18,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    icon: assetPath("app-icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    const capturePath = process.env.DESK_PET_CAPTURE_PATH;
    if (!capturePath) return;
    setTimeout(() => {
      void window
        .capturePage()
        .then((image) => fs.writeFile(capturePath, image.toPNG()))
        .catch((error) => console.error("Failed to capture desk-pet view:", error))
        .finally(() => {
          isQuitting = true;
          app.quit();
        });
    }, 900);
  });
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  void window.loadURL(rendererUrl());
  return window;
}

function sendCaptionState(state: CaptionState): void {
  if (captionWindow && !captionWindow.isDestroyed()) {
    captionWindow.webContents.send("caption:state", state);
  }
}

function sendCaptionEvent(event: CaptionEvent): void {
  if (captionWindow && !captionWindow.isDestroyed()) {
    captionWindow.webContents.send("caption:event", event);
  }
}

function closeCaptionAudioPort(): void {
  captionAudioPort?.close();
  captionAudioPort = null;
}

function captionSamples(value: unknown): Float32Array | undefined {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value);
  }
  if (ArrayBuffer.isView(value) && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value.buffer, value.byteOffset, value.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  return undefined;
}

function connectCaptionAudioPort(): void {
  if (!captionWindow || captionWindow.isDestroyed()) return;
  closeCaptionAudioPort();
  const { port1, port2 } = new MessageChannelMain();
  captionAudioPort = port1;
  port1.on("message", ({ data }) => {
    if (!data || typeof data !== "object") return;
    if ((data as { type?: unknown }).type === "caption-audio-handshake") {
      port1.postMessage({ type: "caption-audio-ready" });
      return;
    }
    const payload = data as { sessionId?: unknown; sampleRate?: unknown; samples?: unknown };
    const samples = captionSamples(payload.samples);
    if (
      typeof payload.sessionId !== "string" ||
      typeof payload.sampleRate !== "number" ||
      !samples
    ) {
      caption.captureEnded("收到的系统音频数据格式无效，请关闭字幕窗口后重新打开。");
      return;
    }
    const accepted = caption.acceptAudio(payload.sessionId, payload.sampleRate, samples);
    if (!accepted && caption.snapshot.phase === "capturing") {
      caption.captureEnded("系统音频数据未被识别器接受，请停止后重新开始。");
    }
  });
  port1.start();
  captionWindow.webContents.postMessage("caption:audio-port", null, [port2]);
}

async function persistCaptionBounds(): Promise<void> {
  if (!captionWindow || captionWindow.isDestroyed()) return;
  const bounds = captionWindow.getBounds();
  await updateStoredConfig((current) => ({
    ...current,
    caption: normalizeCaptionConfig({ ...current.caption, bounds }),
  }));
  if (!captionWindow.isDestroyed()) {
    captionWindow.webContents.send("caption:config", config.caption);
  }
}

function scheduleCaptionBoundsSave(): void {
  if (captionBoundsSaveTimer) clearTimeout(captionBoundsSaveTimer);
  captionBoundsSaveTimer = setTimeout(() => {
    captionBoundsSaveTimer = undefined;
    void persistCaptionBounds().catch((error) => {
      console.error("Failed to save caption window bounds:", error);
    });
  }, 250);
}

function captionWindowBounds(): Electron.Rectangle {
  const stored = config.caption.bounds;
  if (!stored) return defaultCaptionBounds(screen.getPrimaryDisplay().workArea);
  const display = screen.getDisplayMatching(stored);
  return clampCaptionBounds(stored, display.workArea);
}

function createCaptionWindow(): BrowserWindow {
  const bounds = captionWindowBounds();
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    icon: assetPath("app-icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once("ready-to-show", () => window.showInactive());
  window.webContents.on("did-finish-load", connectCaptionAudioPort);
  window.on("moved", scheduleCaptionBoundsSave);
  window.on("closed", () => {
    closeCaptionAudioPort();
    captionWindow = null;
    if (caption.snapshot.phase === "capturing") {
      void caption.stop("实时字幕窗口已关闭。");
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadURL(rendererUrl("caption"));
  return window;
}

function openCaptionWindow(): CaptionState {
  if (!captionWindow || captionWindow.isDestroyed()) captionWindow = createCaptionWindow();
  else {
    captionWindow.showInactive();
    captionWindow.moveTop();
  }
  return caption.snapshot;
}

async function closeCaptionWindow(): Promise<void> {
  if (caption.snapshot.phase !== "downloading") {
    await caption.stop("实时字幕已关闭。");
  }
  if (captionWindow && !captionWindow.isDestroyed()) captionWindow.destroy();
  captionWindow = null;
  closeCaptionAudioPort();
}

function toggleCaptionWindow(): void {
  if (captionWindow && !captionWindow.isDestroyed()) void closeCaptionWindow();
  else openCaptionWindow();
}

function configureDisplayMediaCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const allowedFrame = captionWindow?.webContents.mainFrame;
    if (
      process.platform !== "win32" ||
      !captionWindow ||
      captionWindow.isDestroyed() ||
      !request.frame ||
      !allowedFrame ||
      request.frame.processId !== allowedFrame.processId ||
      request.frame.routingId !== allowedFrame.routingId
    ) {
      callback({});
      return;
    }
    void desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    }).then((sources) => {
      const primaryDisplayId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((candidate) => candidate.display_id === primaryDisplayId) ?? sources[0];
      if (!source || !captionWindow || captionWindow.isDestroyed()) callback({});
      else callback({ video: source, audio: "loopback" });
    }).catch((error) => {
      console.error("Failed to authorize system audio capture:", error);
      callback({});
    });
  });
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(assetPath("tray-icon.png"));
  const nextTray = new Tray(icon.resize({ width: 20, height: 20 }));
  nextTray.setToolTip("desk-pet");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示 / 隐藏",
        click: () => {
          if (mainWindow?.isVisible()) mainWindow.hide();
          else showWindow();
        },
      },
      {
        label: "开始聊天",
        click: () => openWindowMode("chat"),
      },
      {
        label: "设置",
        click: () => openWindowMode("settings"),
      },
      {
        label: "实时字幕",
        click: toggleCaptionWindow,
      },
      { type: "separator" },
      {
        label: "重启本地模型",
        click: () => void runtime.restart(),
      },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  nextTray.on("click", () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showWindow();
  });
  return nextTray;
}

async function pickFile(
  title: string,
  filters: Electron.FileFilter[],
): Promise<FilePickResult | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    properties: ["openFile"],
    filters,
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const path = result.filePaths[0];
  return { path, name: basename(path) };
}

const CHAT_IMAGE_MIME_TYPES: Record<string, ChatImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function pickChatImages(): Promise<ChatImage[]> {
  const options: Electron.OpenDialogOptions = {
    title: "选择要发送给视觉模型的图片",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  if (result.filePaths.length > 4) throw new Error("一次最多选择 4 张图片。");

  const images: ChatImage[] = [];
  let totalBytes = 0;
  for (const path of result.filePaths) {
    const name = basename(path);
    const mimeType = CHAT_IMAGE_MIME_TYPES[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`不支持图片格式：${name}`);
    const stats = await fs.stat(path);
    if (stats.size > 10 * 1024 * 1024) throw new Error(`图片 ${name} 超过 10 MB。`);
    totalBytes += stats.size;
    if (totalBytes > 10 * 1024 * 1024) throw new Error("所选图片合计不能超过 10 MB。");

    let preview = nativeImage.createFromPath(path);
    if (preview.isEmpty()) throw new Error(`无法读取图片：${name}`);
    const size = preview.getSize();
    const scale = Math.min(1, 512 / size.width, 512 / size.height);
    if (scale < 1) {
      preview = preview.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good",
      });
    }
    images.push({ path, name, mimeType, previewUrl: preview.toDataURL() });
  }
  return images;
}

async function pickChatDocuments(): Promise<ChatDocument[]> {
  const options: Electron.OpenDialogOptions = {
    title: "选择要加入对话的文本或 PDF 文档",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "文本与 PDF", extensions: [...CHAT_TEXT_EXTENSIONS, "pdf"] }],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_CHAT_DOCUMENTS) {
    throw new Error(`一次最多选择 ${MAX_CHAT_DOCUMENTS} 个文档。`);
  }

  let totalBytes = 0;
  for (const path of result.filePaths) totalBytes += (await fs.stat(path)).size;
  if (totalBytes > MAX_CHAT_DOCUMENT_TOTAL_BYTES) {
    throw new Error("所选文档合计不能超过 20 MB。");
  }

  const perDocumentLimit = Math.max(
    1,
    Math.floor(MAX_CHAT_DOCUMENT_TOTAL_CHARACTERS / Math.max(1, result.filePaths.length)),
  );
  const documents: ChatDocument[] = [];
  for (const path of result.filePaths) {
    documents.push(await readChatDocument(path, perDocumentLimit));
  }
  return documents;
}

async function probeExecutable(requested?: string): Promise<ProbeResult> {
  const candidates = requested?.trim() ? [requested.trim()] : ["llama", "llama-server"];
  let lastError = "未找到 llama.cpp。";

  for (const executable of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
        timeout: 10_000,
        windowsHide: true,
      });
      const version = `${stdout ?? ""}\n${stderr ?? ""}`.trim().split(/\r?\n/)[0];
      return { ok: true, executable, version: version || "llama.cpp 可执行文件可用" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: false,
    executable: requested?.trim() || "llama",
    error: lastError,
  };
}

function bootstrap(): BootstrapData {
  return {
    config,
    runtime: runtime.snapshot,
    speech: speech.snapshot,
    tts: tts.snapshot,
    caption: caption.snapshot,
    platform: process.platform,
    appVersion: app.getVersion(),
  };
}

async function startSpeechSession(source: "button" | "shortcut") {
  return audioModes.startSpeech(source);
}

async function startCaptionSession(): Promise<CaptionState> {
  return audioModes.startCaption(() => {
    shortcutSessionId = undefined;
    shortcutReleasedBeforeStart = false;
    globalDictationSessions.clear();
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyUserData(): Promise<void> {
  if (process.env.DESK_PET_USER_DATA) return;
  const currentDirectory = app.getPath("userData");
  const legacyDirectory = join(app.getPath("appData"), "minicpm-v-desk-pet");
  if (currentDirectory === legacyDirectory || !(await pathExists(legacyDirectory))) return;

  await fs.mkdir(currentDirectory, { recursive: true });
  const currentConfig = join(currentDirectory, "config.json");
  const legacyConfig = join(legacyDirectory, "config.json");
  if (!(await pathExists(currentConfig)) && (await pathExists(legacyConfig))) {
    await fs.copyFile(legacyConfig, currentConfig);
  }

  const currentModels = join(currentDirectory, "models");
  const legacyModels = join(legacyDirectory, "models");
  if (!(await pathExists(currentModels)) && (await pathExists(legacyModels))) {
    await fs.cp(legacyModels, currentModels, { recursive: true });
  }
}

function registerIpc(): void {
  ipcMain.handle("desktop-pet:get-bootstrap", () => bootstrap());
  ipcMain.handle("desktop-pet:save-config", async (_event, nextConfig: RuntimeConfig) => {
    await updateStoredConfig((current) => ({
      ...nextConfig,
      speech: { ...nextConfig.speech, modelDirectory: current.speech.modelDirectory },
      tts: { ...nextConfig.tts, modelDirectory: current.tts.modelDirectory },
      caption: current.caption,
    }));
    runtime.updateConfig(config);
    speech.updateConfig(config.speech);
    tts.updateConfig(config.tts);
    caption.updateThreads(config.speech.threads);
    configureSpeechShortcut();
    return bootstrap();
  });
  ipcMain.handle("runtime:probe", (_event, executable?: string) => probeExecutable(executable));
  ipcMain.handle("runtime:start", () => runtime.start());
  ipcMain.handle("runtime:stop", () => runtime.stop());
  ipcMain.handle("runtime:restart", () => runtime.restart());
  ipcMain.handle("runtime:list-tools", () => runtime.listTools());
  ipcMain.handle("speech:prepare", async (_event, force?: boolean) => {
    await updateStoredConfig((current) => ({
      ...current,
      speech: { ...current.speech, modelDirectory: "" },
    }));
    speech.updateConfig(config.speech);
    return speech.prepare(force === true);
  });
  ipcMain.handle("speech:import", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择包含 Paraformer 与 SenseVoice 的文件夹",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const directory = result.filePaths[0];
    if (result.canceled || !directory) return null;
    const state = await speech.importFromDirectory(directory);
    await updateStoredConfig((current) => ({
      ...current,
      speech: { ...current.speech, modelDirectory: directory },
    }));
    speech.updateConfig(config.speech);
    return state;
  });
  ipcMain.handle("speech:start", () => startSpeechSession("button"));
  ipcMain.handle("speech:stop", (_event, sessionId: string) => speech.stop(sessionId));
  ipcMain.handle("speech:cancel", (_event, sessionId: string) => speech.cancel(sessionId));
  ipcMain.on("speech:composer-focus", (event, focused: boolean) => {
    if (mainWindow && event.sender === mainWindow.webContents) {
      speechComposerFocused = focused === true;
    }
  });
  ipcMain.handle("tts:prepare", async (_event, force?: boolean) => {
    await updateStoredConfig((current) => ({
      ...current,
      tts: { ...current.tts, modelDirectory: "" },
    }));
    tts.updateConfig(config.tts);
    return tts.prepare(force === true);
  });
  ipcMain.handle("tts:import", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择包含 TTS 模型（model.onnx、lexicon.txt、tokens.txt）的文件夹",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const directory = result.filePaths[0];
    if (result.canceled || !directory) return null;
    const state = await tts.importFromDirectory(directory);
    await updateStoredConfig((current) => ({
      ...current,
      tts: { ...current.tts, modelDirectory: directory },
    }));
    tts.updateConfig(config.tts);
    return state;
  });
  ipcMain.handle("tts:speak", (_event, text: string) => tts.speakText(String(text)));
  ipcMain.handle("tts:stop", () => tts.stopAll());
  ipcMain.handle("caption:open", () => openCaptionWindow());
  ipcMain.handle("caption:close", () => closeCaptionWindow());
  ipcMain.handle("caption:prepare", (_event, force?: boolean) =>
    caption.prepare(force === true));
  ipcMain.handle("caption:start", () => startCaptionSession());
  ipcMain.handle("caption:stop", () => caption.stop());
  ipcMain.handle("caption:clear", () => caption.clear());
  ipcMain.handle("caption:update-config", async (_event, nextConfig: CaptionConfig) => {
    await updateStoredConfig((current) => ({
      ...current,
      caption: normalizeCaptionConfig({
        ...nextConfig,
        bounds: current.caption.bounds,
      }),
    }));
    if (captionWindow && !captionWindow.isDestroyed()) {
      captionWindow.webContents.send("caption:config", config.caption);
    }
    return config.caption;
  });
  ipcMain.on("caption:capture-ended", (event, message: string) => {
    if (!captionWindow || event.sender !== captionWindow.webContents) return;
    caption.captureEnded(String(message || "系统输出音频已停止，请重新启动实时字幕。"));
  });
  ipcMain.handle("dialog:pick-executable", () =>
    pickFile("选择 llama.cpp 可执行文件", [
      { name: "llama.cpp", extensions: process.platform === "win32" ? ["exe"] : ["*"] },
    ]),
  );
  ipcMain.handle("dialog:pick-model", () =>
    pickFile("选择 llama.cpp GGUF 模型", [{ name: "GGUF 模型", extensions: ["gguf"] }]),
  );
  ipcMain.handle("dialog:pick-mmproj", () =>
    pickFile("选择视觉投影模型（mmproj）", [{ name: "GGUF 模型", extensions: ["gguf"] }]),
  );
  ipcMain.handle("dialog:pick-mcp-servers-config", async () => {
    const selection = await pickFile(
      "选择 MCP Servers 配置",
      [{ name: "JSON 配置", extensions: ["json"] }],
    );
    if (!selection) return null;
    validateMcpServersConfigContents(await fs.readFile(selection.path, "utf8"));
    return selection;
  });
  ipcMain.handle("dialog:pick-chat-images", () => pickChatImages());
  ipcMain.handle("dialog:pick-chat-documents", () => pickChatDocuments());
  ipcMain.handle("chat-history:list", () => {
    if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
    return chatHistoryStore.listConversations();
  });
  ipcMain.handle("chat-history:create", () => {
    if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
    return chatHistoryStore.createConversation();
  });
  ipcMain.handle("chat-history:load", (_event, conversationId: string) => {
    if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
    return chatHistoryStore.loadMessages(conversationId);
  });
  ipcMain.handle(
    "chat-history:save",
    (_event, conversationId: string, messages: ChatMessage[]) => {
      if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
      return chatHistoryStore.saveMessages(conversationId, messages);
    },
  );
  ipcMain.handle("chat-history:delete", (_event, conversationId: string) => {
    if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
    chatHistoryStore.deleteConversation(conversationId);
  });
  ipcMain.handle("chat-history:delete-many", (_event, conversationIds: string[]) => {
    if (!chatHistoryStore) throw new Error("本地聊天数据库不可用。");
    if (!Array.isArray(conversationIds)) throw new Error("批量删除参数无效。");
    chatHistoryStore.deleteConversations(conversationIds);
  });
  ipcMain.handle("window:set-mode", (_event, mode: WindowMode) => setWindowMode(mode));
  ipcMain.handle("window:hide", () => mainWindow?.hide());
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接。");
    await shell.openExternal(parsed.toString());
  });
  ipcMain.on("chat:start", (event, request: ChatRequest) => {
    tts.onChatStart(request.requestId);
    void runtime.streamChat(request, (chatEvent) => {
      tts.onChatEvent(chatEvent);
      if (!event.sender.isDestroyed()) event.sender.send("chat:event", chatEvent);
    });
  });
  ipcMain.on("chat:abort", (_event, requestId: string) => {
    runtime.abortChat(requestId);
    tts.interrupt(requestId);
  });
  ipcMain.on(
    "chat:tool-approval",
    (_event, payload: { requestId: string; toolCallId: string; approved: boolean }) => {
      runtime.resolveToolApproval(payload.requestId, payload.toolCallId, payload.approved === true);
    },
  );
}

function sendSpeechState(state: SpeechState): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("speech:state", state);
}

function sendTtsState(state: TtsState): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("tts:state", state);
}

function sendSpeechEvent(event: SpeechEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("speech:event", event);
}

function revealGlobalDictation(): void {
  if (!config.setupComplete) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  setWindowMode("pet");
  mainWindow.webContents.send("app:open-view", "pet");
  if (!mainWindow.isVisible()) {
    mainWindow.showInactive();
  }
  mainWindow.moveTop();
}

async function insertGlobalDictation(event: Extract<SpeechEvent, { type: "final" }>): Promise<void> {
  if (!shortcutHook) throw new Error("全局键盘服务未启动，无法写入当前输入框。");
  const { UiohookKey } = require("uiohook-napi") as typeof import("uiohook-napi");
  await pasteDictationText(event.text, clipboard, shortcutHook, {
    paste: UiohookKey.V,
    control: UiohookKey.Ctrl,
  });
}

function handleSpeechEvent(event: SpeechEvent): void {
  sendSpeechEvent(event);
  if (!("sessionId" in event) || !event.sessionId || !globalDictationSessions.has(event.sessionId)) return;

  if (event.type === "final") {
    globalDictationSessions.delete(event.sessionId);
    void insertGlobalDictation(event)
      .then(() => sendSpeechEvent({ type: "inserted", sessionId: event.sessionId, text: event.text }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Failed to insert global dictation:", error);
        sendSpeechEvent({ type: "insertion-error", sessionId: event.sessionId, message });
      });
  } else if (event.type === "cancelled" || event.type === "error") {
    globalDictationSessions.delete(event.sessionId);
  }
}

function registerShortcutListeners(): void {
  if (!shortcutHook || shortcutListenersRegistered) return;
  const { UiohookKey } = require("uiohook-napi") as typeof import("uiohook-napi");
  shortcutHook.on("keydown", (event) => {
    if (event.keycode !== UiohookKey.F8 || shortcutPressed) return;
    shortcutPressed = true;
    shortcutReleasedBeforeStart = false;
    if (!config.setupComplete || !config.speech.enabled) return;
    if (["downloading", "loading", "recording", "transcribing"].includes(speech.snapshot.phase)) return;
    const source = resolveShortcutSpeechSource(
      speechComposerFocused,
      mainWindow?.isFocused() === true,
    );
    if (source === "shortcut") revealGlobalDictation();
    void startSpeechSession(source)
      .then((result) => {
        shortcutSessionId = result?.sessionId;
        if (shortcutSessionId && source === "shortcut") {
          globalDictationSessions.add(shortcutSessionId);
        }
        if (shortcutReleasedBeforeStart && shortcutSessionId) {
          const sessionId = shortcutSessionId;
          shortcutSessionId = undefined;
          return speech.stop(sessionId);
        }
        return undefined;
      })
      .catch((error) => console.error("Failed to start F8 speech input:", error));
  });
  shortcutHook.on("keyup", (event) => {
    if (event.keycode !== UiohookKey.F8) return;
    shortcutPressed = false;
    shortcutReleasedBeforeStart = true;
    const sessionId = shortcutSessionId;
    shortcutSessionId = undefined;
    if (sessionId) void speech.stop(sessionId).catch((error) => console.error("Failed to stop F8 speech input:", error));
  });
  shortcutListenersRegistered = true;
}

function configureSpeechShortcut(): void {
  const shouldRun = config.setupComplete && config.speech.enabled;
  if (shouldRun && !shortcutHook) {
    try {
      shortcutHook = (require("uiohook-napi") as typeof import("uiohook-napi")).uIOhook;
      registerShortcutListeners();
    } catch (error) {
      console.error("Could not load the F8 speech shortcut:", error);
      return;
    }
  }
  if (shouldRun && shortcutHook && !shortcutHookStarted) {
    shortcutHook.start();
    shortcutHookStarted = true;
  } else if (!shouldRun && shortcutHook && shortcutHookStarted) {
    shortcutHook.stop();
    shortcutHookStarted = false;
  }
}

async function initialize(): Promise<void> {
  if (process.env.DESK_PET_USER_DATA) {
    app.setPath("userData", process.env.DESK_PET_USER_DATA);
  }
  app.setAppUserModelId("cn.local.deskpet");
  try {
    await migrateLegacyUserData();
  } catch (error) {
    console.warn("Could not migrate legacy desk-pet data:", error);
  }
  const modelDirectory = resolveModelDirectory({
    appPath: app.getAppPath(),
    executablePath: app.getPath("exe"),
    isPackaged: app.isPackaged,
    override: process.env.DESK_PET_MODEL_DIRECTORY,
  });
  try {
    await migrateModelDirectory(join(app.getPath("userData"), "models"), modelDirectory);
  } catch (error) {
    console.warn("Could not migrate the desk-pet model cache:", error);
  }
  configStore = new ConfigStore();
  config = await configStore.read();
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    chatHistoryStore = new ChatHistoryStore(join(app.getPath("userData"), "chat-history.sqlite"));
  } catch (error) {
    chatHistoryStore = null;
    console.warn("Could not initialize the local chat database:", error);
  }
  const modelDownloader = new ManagedModelDownloader(
    modelDirectory,
    (input, init) => net.fetch(input, init),
  );
  runtime = new LlamaRuntime(config, (modelId, options) =>
    modelDownloader.resolve(modelId, options),
  );
  const speechModels = new SpeechModelManager(
    modelDirectory,
    app.isPackaged ? join(process.resourcesPath, "scripts") : join(app.getAppPath(), "scripts"),
    undefined,
    config.speech.modelDirectory,
  );
  speech = new SpeechRuntime(config.speech, speechModels);
  caption = new LiveCaptionRuntime(config.speech.threads, speechModels);
  audioModes = new AudioModeCoordinator(speech, caption);
  speech.on("state", sendSpeechState);
  speech.on("event", handleSpeechEvent);
  caption.on("state", sendCaptionState);
  caption.on("event", sendCaptionEvent);
  tts = new TtsRuntime(
    config.tts,
    new TtsModelManager(
      modelDirectory,
      app.isPackaged ? join(process.resourcesPath, "scripts") : join(app.getAppPath(), "scripts"),
      undefined,
      config.tts.modelDirectory,
    ),
    {
      threads: config.speech.threads,
      shouldSilence: () => speech.snapshot.phase === "recording" || speech.snapshot.phase === "transcribing",
    },
  );
  tts.on("state", sendTtsState);
  runtime.on("state", (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("runtime:state", state);
    }
  });

  registerIpc();
  configureDisplayMediaCapture();
  mainWindow = createMainWindow();
  mainWindow.on("blur", () => {
    speechComposerFocused = false;
  });
  tray = createTray();
  configureSpeechShortcut();
  void speech.initializeAvailability();
  void caption.initializeAvailability();
  void tts.initializeAvailability();

  globalShortcut.register("CommandOrControl+Shift+M", () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showWindow(config.setupComplete ? "pet" : "onboarding");
  });
  if (config.setupComplete && config.autoStart) {
    setTimeout(() => void runtime.start(false), 700);
  }
}

const hasLock =
  Boolean(process.env.DESK_PET_CAPTURE_PATH) || app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(initialize).catch((error) => {
    console.error("desk-pet initialization failed:", error);
    dialog.showErrorBox("desk-pet 启动失败", error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
  });
}

app.on("activate", () => showWindow());
app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (shortcutHookStarted) shortcutHook?.stop();
  shortcutHookStarted = false;
  tray?.destroy();
  void runtime?.stop();
  void speech?.dispose();
  void caption?.dispose();
  void tts?.dispose();
  closeCaptionAudioPort();
  captionWindow?.destroy();
  captionWindow = null;
  chatHistoryStore?.close();
  chatHistoryStore = null;
});
app.on("window-all-closed", () => {
  // The tray keeps the pet alive until the user explicitly quits.
});
