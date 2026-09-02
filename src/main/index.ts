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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import type {
  BootstrapData,
  CaptionConfig,
  CaptionEvent,
  CaptionState,
  ProbeResult,
  RuntimeConfig,
  SpeechEvent,
  SpeechState,
  TtsState,
  WindowUiState,
  WindowMode,
  WorkbenchWindowSnapshot,
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
import { ChatAttachmentService } from "./chat-attachment-service";
import { KnowledgeBaseStore } from "./knowledge-base-store";
import { KnowledgeRetriever } from "./knowledge-retriever";
import { LongTaskStore } from "./long-task-store";
import { LongTaskRuntime } from "./long-task-runtime";
import type { LongTaskToolStore } from "./agent/long-task-tool-provider";
import { registerChatIpc } from "./chat-ipc";
import { pasteDictationText, resolveShortcutSpeechSource } from "./global-dictation";
import { AudioModeCoordinator } from "./audio-mode-coordinator";
import { createAsyncBeforeQuitHandler } from "./app-shutdown";
import { LlamaRuntime } from "./llama-runtime";
import { EmbeddingRuntime } from "./embedding-runtime";
import { LiveCaptionRuntime } from "./live-caption-runtime";
import { migrateModelDirectory, resolveModelDirectory } from "./model-directory";
import { validateMcpServersConfigContents } from "./mcp-servers-config";
import { ManagedEmbeddingModelDownloader, ManagedModelDownloader } from "./model-downloader";
import { SpeechModelManager } from "./speech-model-manager";
import { SpeechRuntime } from "./speech-runtime";
import { TtsModelManager } from "./tts-model-manager";
import { TtsRuntime } from "./tts-runtime";
import {
  clampWorkbenchBounds,
  WORKBENCH_DEFAULT_SIZE,
  WORKBENCH_MIN_SIZE,
} from "../shared/window-state";
import { WindowStateStore } from "./window-state-store";

const execFileAsync = promisify(execFile);
app.setName("desk-pet");

let mainWindow: BrowserWindow | null = null;
const chatAttachments = new ChatAttachmentService(() => mainWindow);
let petWindow: BrowserWindow | null = null;
let captionWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let configStore: ConfigStore;
let windowStateStore: WindowStateStore;
let windowUiState: WindowUiState;
let chatHistoryStore: ChatHistoryStore | null = null;
let knowledgeBaseStore: KnowledgeBaseStore | null = null;
let knowledgeRetriever: KnowledgeRetriever | null = null;
let longTaskStore: LongTaskStore | null = null;
let config: RuntimeConfig;
let runtime: LlamaRuntime;
let embeddingRuntime: EmbeddingRuntime;
let longTaskRuntime: LongTaskRuntime | null = null;
let speech: SpeechRuntime;
let tts: TtsRuntime;
let caption: LiveCaptionRuntime;
let audioModes: AudioModeCoordinator;
let currentWindowMode: WindowMode = "pet";
let pendingWindowReveal: WindowMode | null = null;
let pendingWindowRevealTimer: ReturnType<typeof setTimeout> | null = null;
let shortcutHook: typeof import("uiohook-napi").uIOhook | undefined;
let shortcutHookStarted = false;
let shortcutListenersRegistered = false;
let shortcutPressed = false;
let shortcutReleasedBeforeStart = false;
let shortcutSessionId: string | undefined;
let speechComposerFocused = false;
let windowStateSaveTimer: NodeJS.Timeout | undefined;
let windowStateWriteQueue: Promise<void> = Promise.resolve();
const globalDictationSessions = new Set<string>();
let captionAudioPort: Electron.MessagePortMain | null = null;
let captionBoundsSaveTimer: NodeJS.Timeout | undefined;
let configWriteQueue: Promise<void> = Promise.resolve();

function prepareRendererChatForQuit(timeoutMs = 5_000): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.resolve();
  }
  const sender = window.webContents;
  const token = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener("chat:quit-ready", onReady);
      sender.removeListener("destroyed", onDestroyed);
    };
    const finish = (error?: Error): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDestroyed = (): void => finish(new Error("聊天窗口在退出保存完成前已销毁。"));
    const onReady = (
      event: Electron.IpcMainEvent,
      payload: { token?: unknown; ok?: unknown; error?: unknown },
    ): void => {
      if (event.sender !== sender || payload?.token !== token) return;
      if (payload.ok === true) finish();
      else finish(new Error(
        `退出前保存聊天记录失败：${typeof payload.error === "string" ? payload.error : "未知错误"}`,
      ));
    };
    const timer = setTimeout(
      () => finish(new Error(`退出前保存聊天记录在 ${timeoutMs} ms 内未完成。`)),
      timeoutMs,
    );
    ipcMain.on("chat:quit-ready", onReady);
    sender.once("destroyed", onDestroyed);
    try {
      sender.send("chat:prepare-quit", token);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

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

function rendererUrl(view?: string, windowKind?: "pet" | "workbench"): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const url = new URL(devUrl ?? `file://${join(__dirname, "../../dist-renderer/index.html")}`);
  const requestedView = view ?? process.env.DESK_PET_CAPTURE_VIEW;
  if (requestedView) url.searchParams.set("view", requestedView);
  if (windowKind) url.searchParams.set("window", windowKind);
  return url.toString();
}

function requestedWindowMode(): WindowMode | undefined {
  const value = process.env.DESK_PET_CAPTURE_VIEW;
  return value === "pet" || value === "chat" || value === "tasks" || value === "settings" || value === "onboarding"
    ? value
    : undefined;
}

function workbenchSnapshot(): WorkbenchWindowSnapshot {
  return {
    maximized: mainWindow?.isMaximized() ?? windowUiState.workbenchMaximized,
    sidebarCollapsed: windowUiState.sidebarCollapsed,
  };
}

function broadcastWorkbenchState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("window:state", workbenchSnapshot());
  }
}

async function persistWindowState(): Promise<void> {
  const snapshot = windowUiState;
  const task = windowStateWriteQueue.then(async () => {
    await windowStateStore.write(snapshot);
  });
  windowStateWriteQueue = task.catch(() => undefined);
  await task;
}

function scheduleWindowStateSave(): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = undefined;
    void persistWindowState().catch((error) => {
      console.error("Failed to save window state:", error);
    });
  }, 250);
}

function defaultWorkbenchBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: Math.min(WORKBENCH_DEFAULT_SIZE.width, workArea.width),
    height: Math.min(WORKBENCH_DEFAULT_SIZE.height, workArea.height),
    x: workArea.x + Math.max(0, Math.round((workArea.width - WORKBENCH_DEFAULT_SIZE.width) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - WORKBENCH_DEFAULT_SIZE.height) / 2)),
  };
}

function restoredWorkbenchBounds(): Electron.Rectangle {
  const stored = windowUiState.workbenchBounds;
  if (!stored) return defaultWorkbenchBounds();
  const display = screen.getDisplayMatching(stored);
  return clampWorkbenchBounds(stored, display.workArea);
}

function restoredPetBounds(): Electron.Rectangle {
  const size = { width: PET_WINDOW_WIDTH, height: PET_WINDOW_BASE_HEIGHT };
  const stored = windowUiState.petPosition;
  const display = stored
    ? screen.getDisplayNearestPoint(stored)
    : screen.getPrimaryDisplay();
  const fallback = {
    x: display.workArea.x + display.workArea.width - size.width - 18,
    y: display.workArea.y + display.workArea.height - size.height - 18,
  };
  return {
    ...clampWindowPosition(stored ?? fallback, size, display.workArea),
    ...size,
  };
}

function secureWindow(window: BrowserWindow): void {
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
}

function configureCapture(window: BrowserWindow, kind: "pet" | "workbench"): void {
  window.webContents.once("did-finish-load", () => {
    const capturePath = process.env.DESK_PET_CAPTURE_PATH;
    if (!capturePath) return;
    const captureKind = requestedWindowMode() === "pet" ? "pet" : "workbench";
    if (captureKind !== kind) return;
    const configuredDelay = Number(process.env.DESK_PET_CAPTURE_DELAY_MS);
    const captureDelay = Number.isFinite(configuredDelay)
      ? Math.min(10_000, Math.max(100, configuredDelay))
      : 900;
    setTimeout(() => {
      void window.capturePage()
        .then((image) => fs.writeFile(capturePath, image.toPNG()))
        .catch((error) => console.error("Failed to capture desk-pet view:", error))
        .finally(() => {
          isQuitting = true;
          app.quit();
        });
    }, captureDelay);
  });
}

function createPetWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...restoredPetBounds(),
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
  window.on("moved", () => {
    const { x, y } = window.getBounds();
    windowUiState = { ...windowUiState, petPosition: { x, y } };
    scheduleWindowStateSave();
  });
  secureWindow(window);
  configureCapture(window, "pet");
  void window.loadURL(rendererUrl("pet", "pet"));
  return window;
}

function createWorkbenchWindow(initialMode: WindowMode): BrowserWindow {
  const window = new BrowserWindow({
    ...restoredWorkbenchBounds(),
    minWidth: WORKBENCH_MIN_SIZE.width,
    minHeight: WORKBENCH_MIN_SIZE.height,
    frame: true,
    transparent: false,
    backgroundColor: "#fff8e5",
    title: "desk-pet",
    autoHideMenuBar: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    icon: assetPath("app-icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const updateNormalBounds = (): void => {
    if (window.isMaximized() || window.isMinimized()) return;
    windowUiState = { ...windowUiState, workbenchBounds: window.getNormalBounds() };
    scheduleWindowStateSave();
  };
  window.on("moved", updateNormalBounds);
  window.on("resized", updateNormalBounds);
  window.on("maximize", () => {
    windowUiState = { ...windowUiState, workbenchMaximized: true };
    broadcastWorkbenchState();
    scheduleWindowStateSave();
  });
  window.on("unmaximize", () => {
    windowUiState = { ...windowUiState, workbenchMaximized: false };
    broadcastWorkbenchState();
    scheduleWindowStateSave();
  });
  secureWindow(window);
  configureCapture(window, "workbench");
  void window.loadURL(rendererUrl(initialMode, "workbench"));
  return window;
}

function showPetWindow(): void {
  if (!config.setupComplete || !petWindow || petWindow.isDestroyed()) return;
  currentWindowMode = "pet";
  mainWindow?.hide();
  petWindow.show();
  petWindow.moveTop();
}

function showWorkbenchWindow(mode: Exclude<WindowMode, "pet">): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextMode = config.setupComplete ? mode : "onboarding";
  currentWindowMode = nextMode;
  petWindow?.hide();
  mainWindow.webContents.send("app:open-view", nextMode);
  if (!mainWindow.isVisible()) {
    pendingWindowReveal = nextMode;
    mainWindow.setOpacity(0);
    if (pendingWindowRevealTimer) clearTimeout(pendingWindowRevealTimer);
    pendingWindowRevealTimer = setTimeout(() => {
      pendingWindowRevealTimer = null;
      if (!mainWindow || mainWindow.isDestroyed() || pendingWindowReveal !== nextMode) return;
      pendingWindowReveal = null;
      mainWindow.setOpacity(1);
    }, 500);
    mainWindow.show();
  } else {
    mainWindow.show();
  }
  if (windowUiState.workbenchMaximized && !mainWindow.isMaximized()) mainWindow.maximize();
  mainWindow.focus();
}

function setWindowMode(mode: WindowMode): void {
  if (mode === "pet") showPetWindow();
  else showWorkbenchWindow(mode);
}

function showWindow(mode = currentWindowMode): void {
  setWindowMode(config.setupComplete ? mode : "onboarding");
}

function openWindowMode(mode: WindowMode): void {
  setWindowMode(config.setupComplete ? mode : "onboarding");
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
          if (mainWindow?.isVisible() || petWindow?.isVisible()) {
            mainWindow?.hide();
            petWindow?.hide();
          }
          else showWindow();
        },
      },
      {
        label: "开始聊天",
        click: () => openWindowMode("chat"),
      },
      {
        label: "长期任务",
        click: () => openWindowMode("tasks"),
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
        click: () => {
          pauseExecutableLongTasks("聊天模型正在重启，长期任务已暂停。");
          void runtime.restart();
        },
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
    if (mainWindow?.isVisible() || petWindow?.isVisible()) {
      mainWindow?.hide();
      petWindow?.hide();
    }
    else showWindow();
  });
  return nextTray;
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
    embedding: embeddingRuntime.snapshot,
    speech: speech.snapshot,
    tts: tts.snapshot,
    caption: caption.snapshot,
    platform: process.platform,
    appVersion: app.getVersion(),
  };
}

function refreshEmbeddingIndexStats(): void {
  if (!knowledgeBaseStore || !embeddingRuntime) return;
  embeddingRuntime.updateIndexStats(
    knowledgeBaseStore.getEmbeddingStats(embeddingRuntime.fingerprint()),
  );
}

async function reindexKnowledge() {
  if (!config.embedding.enabled) throw new Error("专用向量模型已在设置中停用。");
  if (!knowledgeBaseStore || !knowledgeRetriever) {
    throw new Error("本地知识库尚未初始化。");
  }
  await knowledgeRetriever.indexPendingChunks({ force: true });
  refreshEmbeddingIndexStats();
  return embeddingRuntime.snapshot;
}

function pauseExecutableLongTasks(reason: string): void {
  if (!longTaskRuntime) return;
  for (const task of longTaskRuntime.listTasks()) {
    if (task.status !== "queued" && task.status !== "running" && task.status !== "waiting-approval") {
      continue;
    }
    try {
      longTaskRuntime.pauseTask(task.id, reason);
    } catch (error) {
      console.warn(`[long-task:${task.id}] ${reason}`, error);
    }
  }
}

function requireLongTaskRuntime(): LongTaskRuntime {
  if (!longTaskRuntime) throw new Error("长期任务数据库不可用。");
  return longTaskRuntime;
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
    pauseExecutableLongTasks("模型或工具配置发生变化，长期任务已暂停，请检查后继续。");
    runtime.updateConfig(config);
    await embeddingRuntime.updateConfig(config);
    refreshEmbeddingIndexStats();
    speech.updateConfig(config.speech);
    tts.updateConfig(config.tts);
    caption.updateThreads(config.speech.threads);
    configureSpeechShortcut();
    const data = bootstrap();
    sendToAppWindows("app:bootstrap", data);
    return data;
  });
  ipcMain.handle("runtime:probe", (_event, executable?: string) => probeExecutable(executable));
  ipcMain.handle("runtime:start", () => runtime.start());
  ipcMain.handle("runtime:stop", () => runtime.stop());
  ipcMain.handle("runtime:restart", () => {
    pauseExecutableLongTasks("聊天模型正在重启，长期任务已暂停。");
    return runtime.restart();
  });
  ipcMain.handle("runtime:list-tools", () => runtime.listTools());
  ipcMain.handle("embedding:start", () => embeddingRuntime.start(false));
  ipcMain.handle("embedding:prepare", (_event, force?: boolean) =>
    embeddingRuntime.prepare(force === true));
  ipcMain.handle("embedding:stop", () => embeddingRuntime.stop());
  ipcMain.handle("knowledge:reindex", () => reindexKnowledge());
  ipcMain.handle("long-task:list", () => requireLongTaskRuntime().listTasks());
  ipcMain.handle("long-task:create", (_event, input) => requireLongTaskRuntime().createTask(input));
  ipcMain.handle("long-task:start", (_event, taskId: string) => requireLongTaskRuntime().startTask(taskId));
  ipcMain.handle("long-task:pause", (_event, taskId: string) => requireLongTaskRuntime().pauseTask(taskId));
  ipcMain.handle("long-task:cancel", (_event, taskId: string) => requireLongTaskRuntime().cancelTask(taskId));
  ipcMain.handle("long-task:delete", (_event, taskId: string) => requireLongTaskRuntime().deleteTask(taskId));
  ipcMain.on("long-task:approval", (event, payload: {
    taskId?: unknown;
    requestId?: unknown;
    toolCallId?: unknown;
    approved?: unknown;
  }) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (
      typeof payload?.taskId !== "string"
      || typeof payload.requestId !== "string"
      || typeof payload.toolCallId !== "string"
    ) return;
    try {
      requireLongTaskRuntime().resolveApproval(
        payload.taskId,
        payload.requestId,
        payload.toolCallId,
        payload.approved === true,
      );
    } catch (error) {
      console.warn("Could not resolve long-task tool approval:", error);
    }
  });
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
    chatAttachments.pickFile("选择 llama.cpp 可执行文件", [
      { name: "llama.cpp", extensions: process.platform === "win32" ? ["exe"] : ["*"] },
    ]),
  );
  ipcMain.handle("dialog:pick-model", () =>
    chatAttachments.pickFile("选择 llama.cpp GGUF 模型", [{ name: "GGUF 模型", extensions: ["gguf"] }]),
  );
  ipcMain.handle("dialog:pick-embedding-model", () =>
    chatAttachments.pickFile("选择专用 Embedding GGUF 模型", [{ name: "GGUF 模型", extensions: ["gguf"] }]),
  );
  ipcMain.handle("dialog:pick-mmproj", () =>
    chatAttachments.pickFile("选择视觉投影模型（mmproj）", [{ name: "GGUF 模型", extensions: ["gguf"] }]),
  );
  ipcMain.handle("dialog:pick-mcp-servers-config", async () => {
    const selection = await chatAttachments.pickFile(
      "选择 MCP Servers 配置",
      [{ name: "JSON 配置", extensions: ["json"] }],
    );
    if (!selection) return null;
    validateMcpServersConfigContents(await fs.readFile(selection.path, "utf8"));
    return selection;
  });
  ipcMain.handle("dialog:pick-chat-images", () => chatAttachments.pickImages());
  ipcMain.handle("dialog:pick-chat-documents", () => chatAttachments.pickDocuments());
  ipcMain.handle("knowledge:list", () => knowledgeBaseStore?.listDocuments() ?? []);
  ipcMain.handle("knowledge:import", async () => {
    if (!knowledgeBaseStore) throw new Error("本地知识库尚未初始化。");
    const documents = await chatAttachments.pickKnowledgeDocuments();
    if (!documents.length) return null;
    for (const document of documents) knowledgeBaseStore.upsertDocument(document);
    refreshEmbeddingIndexStats();
    return knowledgeBaseStore.listDocuments();
  });
  ipcMain.handle("knowledge:delete", (_event, documentId: string) => {
    if (!knowledgeBaseStore) throw new Error("本地知识库尚未初始化。");
    if (typeof documentId !== "string") throw new Error("知识库文档 ID 无效。");
    knowledgeBaseStore.deleteDocument(documentId);
    refreshEmbeddingIndexStats();
    return knowledgeBaseStore.listDocuments();
  });
  registerChatIpc({
    runtime,
    tts,
    getHistoryStore: () => chatHistoryStore,
    isQuitting: () => isQuitting,
  });
  ipcMain.handle("window:set-mode", (event, mode: WindowMode) => {
    const trustedSender = event.sender === mainWindow?.webContents || event.sender === petWindow?.webContents;
    if (!trustedSender) throw new Error("不允许此窗口切换应用视图。");
    if (!["pet", "chat", "tasks", "settings", "onboarding"].includes(mode)) {
      throw new Error("未知的窗口视图。");
    }
    setWindowMode(mode);
  });
  ipcMain.handle("window:hide", (event) => {
    if (event.sender === petWindow?.webContents) petWindow?.hide();
    else if (event.sender === mainWindow?.webContents) mainWindow?.hide();
    else throw new Error("不允许此窗口隐藏应用。");
  });
  ipcMain.handle("window:minimize", (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("仅工作台可以最小化。");
    mainWindow.minimize();
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("仅工作台可以最大化。");
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return workbenchSnapshot();
  });
  ipcMain.handle("window:get-state", (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("仅工作台可以读取窗口状态。");
    return workbenchSnapshot();
  });
  ipcMain.handle("window:set-sidebar-collapsed", async (event, collapsed: boolean) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("仅工作台可以更新侧栏状态。");
    windowUiState = { ...windowUiState, sidebarCollapsed: collapsed === true };
    await persistWindowState();
    broadcastWorkbenchState();
    return workbenchSnapshot();
  });
  ipcMain.on("window:view-ready", (event, mode: WindowMode) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      pendingWindowReveal !== mode
    ) return;
    pendingWindowReveal = null;
    if (pendingWindowRevealTimer) {
      clearTimeout(pendingWindowRevealTimer);
      pendingWindowRevealTimer = null;
    }
    mainWindow.setOpacity(1);
    mainWindow.moveTop();
  });
  ipcMain.handle("app:copy-text", (_event, text: string) => {
    clipboard.writeText(String(text));
  });
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 链接。");
    await shell.openExternal(parsed.toString());
  });
}

function sendSpeechState(state: SpeechState): void {
  sendToAppWindows("speech:state", state);
}

function sendTtsState(state: TtsState): void {
  sendToAppWindows("tts:state", state);
}

function sendSpeechEvent(event: SpeechEvent): void {
  sendToAppWindows("speech:event", event);
}

function sendToAppWindows(channel: string, payload: unknown): void {
  for (const window of [mainWindow, petWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function revealGlobalDictation(): void {
  if (!config.setupComplete) return;
  if (!petWindow || petWindow.isDestroyed() || mainWindow?.isFocused()) return;
  currentWindowMode = "pet";
  mainWindow?.hide();
  if (!petWindow.isVisible()) petWindow.showInactive();
  petWindow.moveTop();
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
  windowStateStore = new WindowStateStore();
  windowUiState = await windowStateStore.read();
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    chatHistoryStore = new ChatHistoryStore(join(app.getPath("userData"), "chat-history.sqlite"));
  } catch (error) {
    chatHistoryStore = null;
    console.warn("Could not initialize the local chat database:", error);
  }
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    knowledgeBaseStore = new KnowledgeBaseStore(join(app.getPath("userData"), "knowledge.sqlite"));
  } catch (error) {
    knowledgeBaseStore = null;
    console.warn("Could not initialize the local knowledge database:", error);
  }
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    longTaskStore = new LongTaskStore(join(app.getPath("userData"), "long-tasks.sqlite"));
  } catch (error) {
    longTaskStore = null;
    console.warn("Could not initialize the durable long-task database:", error);
  }
  const modelDownloader = new ManagedModelDownloader(
    modelDirectory,
    (input, init) => net.fetch(input, init),
  );
  const embeddingModelDownloader = new ManagedEmbeddingModelDownloader(
    modelDirectory,
    (input, init) => net.fetch(input, init),
  );
  embeddingRuntime = new EmbeddingRuntime(
    config,
    (modelId, options) => embeddingModelDownloader.resolve(modelId, options),
    (input, init) => net.fetch(input, init),
  );
  knowledgeRetriever = knowledgeBaseStore
    ? new KnowledgeRetriever(knowledgeBaseStore, embeddingRuntime, {
        onWarning: (message) => console.warn(`[knowledge-retriever] ${message}`),
        onIndexProgress: (stats) => embeddingRuntime.updateIndexStats(stats),
      })
    : null;
  const longTaskToolStore: LongTaskToolStore | undefined = longTaskStore
    ? {
        createTask: (input) => longTaskRuntime
          ? longTaskRuntime.createTask(input)
          : longTaskStore!.createTask(input),
        listTasks: () => longTaskRuntime
          ? longTaskRuntime.listTasks()
          : longTaskStore!.listTasks(),
        getTask: (taskId) => longTaskStore!.getTask(taskId),
      }
    : undefined;
  runtime = new LlamaRuntime(
    config,
    (modelId, options) => modelDownloader.resolve(modelId, options),
    knowledgeRetriever ?? knowledgeBaseStore ?? undefined,
    longTaskToolStore,
  );
  longTaskRuntime = longTaskStore ? new LongTaskRuntime(longTaskStore, runtime) : null;
  refreshEmbeddingIndexStats();
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
    sendToAppWindows("runtime:state", state);
  });
  embeddingRuntime.on("state", (state) => {
    sendToAppWindows("embedding:state", state);
  });
  longTaskRuntime?.on("event", (event) => {
    sendToAppWindows("long-task:event", event);
  });
  runtime.on("log", (message: string) => {
    console.warn(`[llama-runtime] ${message}`);
  });

  registerIpc();
  configureDisplayMediaCapture();
  const requestedMode = requestedWindowMode();
  const initialMode: WindowMode = config.setupComplete
    ? requestedMode ?? "pet"
    : "onboarding";
  currentWindowMode = initialMode;
  mainWindow = createWorkbenchWindow(initialMode === "pet" ? "chat" : initialMode);
  petWindow = createPetWindow();
  mainWindow.on("blur", () => {
    speechComposerFocused = false;
  });
  if (initialMode === "pet") {
    petWindow.once("ready-to-show", showPetWindow);
  } else {
    mainWindow.once("ready-to-show", () => showWorkbenchWindow(initialMode));
  }
  tray = createTray();
  configureSpeechShortcut();
  void speech.initializeAvailability();
  void caption.initializeAvailability();
  void tts.initializeAvailability();

  globalShortcut.register("CommandOrControl+Shift+M", () => {
    if (mainWindow?.isVisible() || petWindow?.isVisible()) {
      mainWindow?.hide();
      petWindow?.hide();
    } else {
      openWindowMode("pet");
    }
  });
  if (config.setupComplete && config.autoStart) {
    setTimeout(() => void runtime.start(false), 700);
  }
}

if (process.env.DESK_PET_USER_DATA) {
  // The single-instance lock is scoped to userData, so test profiles must be
  // selected before requesting it.
  app.setPath("userData", process.env.DESK_PET_USER_DATA);
}

const hasLock =
  Boolean(process.env.DESK_PET_CAPTURE_PATH)
  || app.requestSingleInstanceLock();
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
app.on("before-quit", createAsyncBeforeQuitHandler({
  begin: () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (shortcutHookStarted) shortcutHook?.stop();
    shortcutHookStarted = false;
    tray?.destroy();
    closeCaptionAudioPort();
    captionWindow?.destroy();
    captionWindow = null;
    petWindow?.destroy();
    petWindow = null;
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = undefined;
  },
  cleanup: async () => {
    const results = await Promise.allSettled([
      prepareRendererChatForQuit(),
      longTaskRuntime?.dispose() ?? Promise.resolve(),
      runtime?.stop(),
      embeddingRuntime?.stop(),
      speech?.dispose(),
      caption?.dispose(),
      tts?.dispose(),
      windowStateStore ? persistWindowState() : Promise.resolve(),
    ]);
    const failures: unknown[] = results.flatMap((result) => result.status === "rejected"
      ? [result.reason]
      : []);
    if (results[0].status === "fulfilled") {
      try {
        chatHistoryStore?.close();
        chatHistoryStore = null;
      } catch (error) {
        failures.push(error);
      }
    } else {
      console.warn("Leaving chat history open because the renderer did not acknowledge persistence.");
    }
    try {
      knowledgeBaseStore?.close();
      knowledgeBaseStore = null;
    } catch (error) {
      failures.push(error);
    }
    try {
      longTaskStore?.close();
      longTaskStore = null;
      longTaskRuntime = null;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "应用退出清理失败");
  },
  quit: () => app.quit(),
  onError: (error) => {
    console.error("desk-pet shutdown cleanup failed:", error);
  },
}));
app.on("window-all-closed", () => {
  // The tray keeps the pet alive until the user explicitly quits.
});
