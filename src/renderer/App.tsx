import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {
  BootstrapData,
  ChatDocument,
  ChatImage,
  RuntimeConfig,
  RuntimeState,
  SpeechEvent,
  SpeechState,
  TtsState,
  WindowMode,
} from "../shared/types";
import { Pet, type PetMood } from "./components/Pet";
import { resolveSpeechPetClipMood } from "./components/pet-clips";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { flushChatPersistence } from "./chat-persistence-coordinator";
import {
  confirmWorkbenchNavigation,
  shouldUpdateRendererView,
} from "./workbench-navigation";

const ChatPanel = lazy(() => import("./components/ChatPanel").then((module) => ({
  default: module.ChatPanel,
})));
const Onboarding = lazy(() => import("./components/Onboarding").then((module) => ({
  default: module.Onboarding,
})));
const Settings = lazy(() => import("./components/Settings").then((module) => ({
  default: module.Settings,
})));

interface GlobalSpeechFeedback {
  sessionId: string;
  text: string;
  phase: "recording" | "transcribing" | "done" | "error";
}

function WorkbenchLoading() {
  return (
    <main
      className="grid h-full place-items-center bg-background text-foreground"
      aria-busy="true"
    >
      <div className="grid justify-items-center gap-3 text-center" role="status" aria-live="polite">
        <Spinner className="size-5 text-primary" />
        <div>
          <b className="block text-sm font-medium">正在准备本地工作台</b>
          <span className="mt-1 block text-xs text-muted-foreground">
            正在恢复模型、对话和工具状态…
          </span>
        </div>
      </div>
    </main>
  );
}

function SettingsLoading() {
  return (
    <div className="grid h-full place-items-center bg-card" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-primary" />
        正在载入设置…
      </div>
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [tts, setTts] = useState<TtsState | null>(null);
  const [view, setView] = useState<WindowMode>("pet");
  const [fatalError, setFatalError] = useState("");
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<ChatImage[]>([]);
  const [draftDocuments, setDraftDocuments] = useState<ChatDocument[]>([]);
  const draftRef = useRef("");
  const speechBaseDraftRef = useRef("");
  const activeSpeechRef = useRef<string | null>(null);
  const globalSpeechRef = useRef<string | null>(null);
  const globalSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewTransitionRef = useRef(false);
  const preparingSpeechRef = useRef(false);
  const [globalSpeech, setGlobalSpeech] = useState<GlobalSpeechFeedback | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const windowKind = new URLSearchParams(location.search).get("window");

  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };

  const speechDraft = (base: string, transcript: string) => {
    const separator = base && !/\s$/u.test(base) ? " " : "";
    return `${base}${separator}${transcript}`;
  };

  const transitionToView = async (nextView: WindowMode) => {
    if (viewTransitionRef.current || nextView === view) return;
    viewTransitionRef.current = true;
    const root = document.documentElement;
    try {
      root.classList.add("view-transitioning");
      await new Promise((resolve) => setTimeout(resolve, 165));
      await window.desktopPet.setWindowMode(nextView);
      if (shouldUpdateRendererView(windowKind, nextView)) setView(nextView);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    } finally {
      root.classList.remove("view-transitioning");
      viewTransitionRef.current = false;
    }
  };

  useEffect(() => {
    const applyBootstrap = (data: BootstrapData): void => {
      setBootstrap(data);
      setRuntime(data.runtime);
      setSpeech(data.speech);
      setTts(data.tts);
    };
    window.desktopPet
      .getBootstrap()
      .then((data) => {
        applyBootstrap(data);
        const requestedView = new URLSearchParams(location.search).get("view");
        const isKnownView =
          requestedView === "pet" ||
          requestedView === "chat" ||
          requestedView === "settings" ||
          requestedView === "onboarding";
        setView(
          data.config.setupComplete && isKnownView
            ? requestedView
            : data.config.setupComplete
              ? "pet"
              : "onboarding",
        );
      })
      .catch((error) => setFatalError(error instanceof Error ? error.message : String(error)));
    const stopBootstrapUpdates = window.desktopPet.onBootstrap((data) => {
      applyBootstrap(data);
      if (windowKind === "pet" && data.config.setupComplete) setView("pet");
    });
    const stopRuntimeUpdates = window.desktopPet.onRuntimeState(setRuntime);
    return () => {
      stopBootstrapUpdates();
      stopRuntimeUpdates();
    };
  }, [windowKind]);

  useEffect(() => window.desktopPet.onPrepareQuit((token) => {
    document.documentElement.inert = true;
    document.documentElement.setAttribute("aria-busy", "true");
    void flushChatPersistence().then(
      () => window.desktopPet.acknowledgeQuitPreparation(token, { ok: true }),
      (error) => window.desktopPet.acknowledgeQuitPreparation(token, {
        ok: false,
        error: String(error instanceof Error ? error.message : error).slice(0, 2_000),
      }),
    );
  }), []);

  const prepareSpeech = async (force = false) => {
    if (preparingSpeechRef.current) return;
    if (!window.confirm(force
      ? "将重新下载约 450 MB 的本地语音模型，是否继续？"
      : "首次使用语音输入需要下载约 450 MB 的本地模型。模型将保存到项目或应用旁的 models/speech，是否继续？")) return;
    preparingSpeechRef.current = true;
    try {
      setSpeech(await window.desktopPet.prepareSpeech(force));
    } catch (error) {
      console.error("Failed to prepare local speech models:", error);
    } finally {
      preparingSpeechRef.current = false;
    }
  };

  const importSpeechModels = async () => {
    try {
      const state = await window.desktopPet.importSpeechModels();
      if (state) setSpeech(state);
    } catch (error) {
      console.error("Failed to import local speech models:", error);
    }
  };

  const prepareTts = async (force = false) => {
    if (!window.confirm(force
      ? "将重新下载约 170 MB 的本地语音朗读模型，是否继续？"
      : "首次使用语音朗读需要下载约 170 MB 的本地模型（含发音数据）。模型将保存到项目或应用旁的 models/speech，是否继续？")) return;
    try {
      setTts(await window.desktopPet.prepareTts(force));
    } catch (error) {
      console.error("Failed to prepare local TTS models:", error);
    }
  };

  const importTtsModels = async () => {
    try {
      const state = await window.desktopPet.importTtsModels();
      if (state) setTts(state);
    } catch (error) {
      console.error("Failed to import local TTS models:", error);
    }
  };

  const speakText = async (text: string) => {
    try {
      setTts(await window.desktopPet.speakText(text));
    } catch (error) {
      console.error("Failed to speak text:", error);
    }
  };

  const stopSpeaking = async () => {
    try {
      setTts(await window.desktopPet.stopSpeaking());
    } catch (error) {
      console.error("Failed to stop speaking:", error);
    }
  };

  useEffect(() => {
    const unsubscribeState = window.desktopPet.onSpeechState(setSpeech);
    const unsubscribeTtsState = window.desktopPet.onTtsState(setTts);
    const unsubscribeEvent = window.desktopPet.onSpeechEvent((event: SpeechEvent) => {
      if (event.type === "setup-required") {
        void prepareSpeech();
        return;
      }
      if (event.type === "started") {
        if (event.source === "shortcut") {
          if (globalSpeechTimerRef.current) clearTimeout(globalSpeechTimerRef.current);
          globalSpeechRef.current = event.sessionId;
          setGlobalSpeech({
            sessionId: event.sessionId,
            text: "正在聆听…",
            phase: "recording",
          });
          return;
        }
        speechBaseDraftRef.current = draftRef.current;
        activeSpeechRef.current = event.sessionId;
        return;
      }
      if (event.sessionId && event.sessionId === globalSpeechRef.current) {
        if (event.type === "partial") {
          setGlobalSpeech({ sessionId: event.sessionId, text: event.text || "正在聆听…", phase: "recording" });
        } else if (event.type === "final") {
          setGlobalSpeech({ sessionId: event.sessionId, text: event.text, phase: "transcribing" });
        } else if (event.type === "inserted") {
          setGlobalSpeech({ sessionId: event.sessionId, text: event.text, phase: "done" });
          globalSpeechRef.current = null;
          globalSpeechTimerRef.current = setTimeout(() => setGlobalSpeech(null), 1_500);
        } else if (event.type === "cancelled") {
          setGlobalSpeech({ sessionId: event.sessionId, text: event.message, phase: "error" });
          globalSpeechRef.current = null;
          globalSpeechTimerRef.current = setTimeout(() => setGlobalSpeech(null), 1_500);
        } else if (event.type === "insertion-error" || event.type === "error") {
          setGlobalSpeech({ sessionId: event.sessionId, text: event.message, phase: "error" });
          globalSpeechRef.current = null;
          globalSpeechTimerRef.current = setTimeout(() => setGlobalSpeech(null), 3_000);
        }
        return;
      }
      if (!event.sessionId || event.sessionId !== activeSpeechRef.current) return;
      if (event.type === "partial") {
        updateDraft(speechDraft(speechBaseDraftRef.current, event.text));
      } else if (event.type === "final") {
        updateDraft(speechDraft(speechBaseDraftRef.current, event.text));
        activeSpeechRef.current = null;
      } else if (event.type === "cancelled" || event.type === "error") {
        updateDraft(speechBaseDraftRef.current);
        activeSpeechRef.current = null;
      }
    });
    return () => {
      unsubscribeState();
      unsubscribeTtsState();
      unsubscribeEvent();
      if (globalSpeechTimerRef.current) clearTimeout(globalSpeechTimerRef.current);
    };
  }, []);

  const acceptWorkbenchNavigation = (nextView: "chat" | "settings" | "pet"): boolean => {
    const allowed = confirmWorkbenchNavigation(
      view === "settings" ? "settings" : view === "pet" ? "pet" : "chat",
      nextView,
      settingsDirty,
      () => window.confirm("设置尚未保存，确定要放弃这些修改吗？"),
    );
    if (!allowed) return false;
    if (view === "settings" && settingsDirty && nextView !== "settings") {
      setSettingsDirty(false);
    }
    return true;
  };

  useEffect(() => window.desktopPet.onOpenView((mode) => {
    if (shouldUpdateRendererView(windowKind, mode)) {
      const allowed = mode === "onboarding" || acceptWorkbenchNavigation(mode);
      if (allowed) setView(mode);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.desktopPet.notifyViewReady(mode));
    });
  }), [settingsDirty, view, windowKind]);

  const mood: PetMood = !runtime
    ? "sleeping"
    : runtime.phase === "error"
      ? "sad"
      : runtime.phase === "starting" || runtime.phase === "downloading"
        ? "thinking"
        : runtime.phase === "stopped"
          ? "sleeping"
          : tts?.phase === "speaking"
            ? "talking"
            : "idle";

  const finishOnboarding = async (nextConfig: RuntimeConfig) => {
    const data = await window.desktopPet.saveConfig(nextConfig);
    setBootstrap(data);
    setRuntime(data.runtime);
    await transitionToView("chat");
    setRuntime(await window.desktopPet.startRuntime());
  };

  const saveSettings = async (nextConfig: RuntimeConfig, restart: boolean) => {
    const data = await window.desktopPet.saveConfig({ ...nextConfig, setupComplete: true });
    setBootstrap(data);
    setRuntime(data.runtime);
    setSpeech(data.speech);
    setTts(data.tts);
    if (!data.config.mmprojPath) setDraftImages([]);
    if (restart) {
      setRuntime(await window.desktopPet.restartRuntime());
    }
    setSettingsDirty(false);
  };

  const navigateFromWorkbench = (nextView: "chat" | "settings" | "pet"): boolean => {
    if (!acceptWorkbenchNavigation(nextView)) return false;
    void transitionToView(nextView);
    return true;
  };

  const startRuntime = async () => setRuntime(await window.desktopPet.startRuntime());

  const startSpeech = async (): Promise<string | undefined> => {
    if (!speech || !speech.enabled) return undefined;
    if (speech.phase === "not-installed") {
      await prepareSpeech();
      return undefined;
    }
    const result = await window.desktopPet.startSpeech();
    return result?.sessionId;
  };

  const stopSpeech = async (sessionId: string) => {
    setSpeech(await window.desktopPet.stopSpeech(sessionId));
  };

  const globalSpeechPhase = globalSpeech?.phase === "recording" && speech?.phase === "transcribing"
    ? "transcribing"
    : globalSpeech?.phase;
  const globalSpeechTitle = globalSpeechPhase === "recording"
    ? "团子正在听"
    : globalSpeechPhase === "transcribing"
      ? "团子正在转成文字"
      : globalSpeechPhase === "done"
        ? "已输入当前文本框"
        : "这次没有输入";
  const globalSpeechBubble = globalSpeech && globalSpeechPhase ? (
    windowKind === "workbench" ? (
      <aside
        aria-label={globalSpeechTitle}
        className="fixed bottom-5 left-1/2 z-50 flex h-10 -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-4 text-popover-foreground shadow-[var(--ui-surface-shadow)]"
        aria-live="polite"
      >
        {[0.6, 1, 0.75, 0.9].map((height, index) => (
          <i
            aria-hidden="true"
            className={`w-0.5 animate-pulse rounded-full ${
              globalSpeechPhase === "error" ? "bg-destructive" : "bg-primary"
            }`}
            key={height}
            style={{ animationDelay: `${index * 100}ms`, height: `${8 + height * 12}px` }}
          />
        ))}
      </aside>
    ) : (
      <aside className={`global-speech-bubble phase-${globalSpeechPhase}`} aria-live="polite">
        <span className="global-speech-bubble__status" aria-hidden="true" />
        <div>
          <b>{globalSpeechTitle}</b>
          <p>{globalSpeech.text}</p>
        </div>
      </aside>
    )
  ) : null;

  if (fatalError) {
    if (windowKind === "workbench") {
      return (
        <main className="grid h-full place-items-center bg-background p-6 text-foreground">
          <section className="grid w-full max-w-md gap-4 rounded-xl border bg-card p-6 text-center shadow-[var(--ui-surface-shadow)]">
            <div>
              <h1 className="text-xl font-semibold">工作台启动失败</h1>
              <p className="mt-2 text-sm text-muted-foreground">{fatalError}</p>
            </div>
            <Button className="justify-self-center" type="button" onClick={() => location.reload()}>
              重试
            </Button>
          </section>
        </main>
      );
    }
    return (
      <main className="surface fatal-error">
        <h1>desk-pet 没能醒来</h1>
        <p>{fatalError}</p>
        <button className="button button--primary" type="button" onClick={() => location.reload()}>重试</button>
      </main>
    );
  }

  if (!bootstrap || !runtime || !speech || !tts) {
    if (windowKind === "workbench") {
      return <WorkbenchLoading />;
    }
    return (
      <main className="loading-screen" aria-busy="true">
        <div className="loading-pet" aria-hidden="true">
          <span className="loading-pet__glow" />
          <Pet mood="sleeping" compact />
        </div>
        <div className="loading-status" role="status" aria-live="polite">
          <span className="loading-status__text">团子正在醒来</span>
          <span className="loading-paws" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </main>
    );
  }

  if (view === "onboarding" || !bootstrap.config.setupComplete) {
    return (
      <Suspense fallback={<WorkbenchLoading />}>
        <Onboarding
          initialConfig={bootstrap.config}
          platform={bootstrap.platform}
          onComplete={finishOnboarding}
        />
      </Suspense>
    );
  }

  if (windowKind !== "pet" && (view === "chat" || view === "settings")) {
    const modelLabel = bootstrap.config.modelMode === "local"
      ? bootstrap.config.modelPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "本地 GGUF"
      : bootstrap.config.hfRepo;
    return (
      <Suspense fallback={<WorkbenchLoading />}>
        <ChatPanel
          runtime={runtime}
          speech={speech}
          tts={tts}
          chatTemplates={bootstrap.config.chatTemplates}
          maxTokens={bootstrap.config.maxTokens}
          contextSize={bootstrap.config.contextSize}
          modelLabel={modelLabel}
          draft={draft}
          images={draftImages}
          documents={draftDocuments}
          onDraftChange={updateDraft}
          onImagesChange={setDraftImages}
          onDocumentsChange={setDraftDocuments}
          visionEnabled={runtime.visionEnabled}
          onPrepareSpeech={prepareSpeech}
          onStartSpeech={startSpeech}
          onStopSpeech={stopSpeech}
          onSpeakText={speakText}
          onStopSpeaking={stopSpeaking}
          onClose={() => navigateFromWorkbench("pet")}
          onStartRuntime={startRuntime}
          activePage={view}
          onNavigate={(page) => navigateFromWorkbench(page)}
          onOpenCaption={() => void window.desktopPet.openCaptionWindow()}
          settingsContent={view === "settings" ? (
            <Suspense fallback={<SettingsLoading />}>
              <Settings
                initialConfig={bootstrap.config}
                runtime={runtime}
                speech={speech}
                tts={tts}
                embedded
                onDirtyChange={setSettingsDirty}
                onPrepareSpeech={prepareSpeech}
                onImportSpeech={importSpeechModels}
                onPrepareTts={prepareTts}
                onImportTts={importTtsModels}
                onSpeakText={speakText}
                onStopSpeaking={stopSpeaking}
                onOpenCaption={async () => {
                  await window.desktopPet.openCaptionWindow();
                }}
                onClose={() => navigateFromWorkbench("chat")}
                onSave={saveSettings}
              />
            </Suspense>
          ) : null}
        />
        {globalSpeechBubble}
      </Suspense>
    );
  }

  return (
    <main className="pet-stage">
      <Pet
        mood={speech.phase === "recording"
          ? "listening"
          : speech.phase === "transcribing"
            ? "transcribing"
            : mood}
        clipMood={resolveSpeechPetClipMood(speech.phase)}
        windowDrag
        onClick={() => void transitionToView("chat")}
      />
      {globalSpeechBubble}
    </main>
  );
}
