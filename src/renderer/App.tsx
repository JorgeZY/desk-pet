import { useEffect, useRef, useState } from "react";
import type {
  BootstrapData,
  ChatImage,
  RuntimeConfig,
  RuntimeState,
  SpeechEvent,
  SpeechState,
  TtsState,
  WindowMode,
} from "../shared/types";
import { ChatPanel } from "./components/ChatPanel";
import { Onboarding } from "./components/Onboarding";
import { Pet, type PetMood } from "./components/Pet";
import { Settings } from "./components/Settings";

interface GlobalSpeechFeedback {
  sessionId: string;
  text: string;
  phase: "recording" | "transcribing" | "done" | "error";
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
  const draftRef = useRef("");
  const speechBaseDraftRef = useRef("");
  const activeSpeechRef = useRef<string | null>(null);
  const globalSpeechRef = useRef<string | null>(null);
  const globalSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewTransitionRef = useRef(false);
  const preparingSpeechRef = useRef(false);
  const [globalSpeech, setGlobalSpeech] = useState<GlobalSpeechFeedback | null>(null);

  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };

  const speechDraft = (base: string, transcript: string) => {
    const separator = base && !/\s$/u.test(base) ? " " : "";
    return `${base}${separator}${transcript}`;
  };

  const transitionToView = async (nextView: WindowMode) => {
    if (nextView === "chat") window.desktopPet.notifyChatUserActivity();
    if (viewTransitionRef.current || nextView === view) return;
    viewTransitionRef.current = true;
    const root = document.documentElement;
    try {
      root.classList.add("view-transitioning");
      await new Promise((resolve) => setTimeout(resolve, 165));
      await window.desktopPet.setWindowMode(nextView);
      setView(nextView);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    } finally {
      root.classList.remove("view-transitioning");
      viewTransitionRef.current = false;
    }
  };

  useEffect(() => {
    window.desktopPet
      .getBootstrap()
      .then((data) => {
        setBootstrap(data);
        setRuntime(data.runtime);
        setSpeech(data.speech);
        setTts(data.tts);
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
    return window.desktopPet.onRuntimeState(setRuntime);
  }, []);

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

  useEffect(() => window.desktopPet.onOpenView(setView), []);

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
    if (!data.config.mmprojPath) setDraftImages([]);
    if (restart) setRuntime(await window.desktopPet.restartRuntime());
    await transitionToView("pet");
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

  const cancelSpeech = async (sessionId: string) => {
    setSpeech(await window.desktopPet.cancelSpeech(sessionId));
  };

  const globalSpeechPhase = globalSpeech?.phase === "recording" && speech?.phase === "transcribing"
    ? "transcribing"
    : globalSpeech?.phase;
  const globalSpeechBubble = globalSpeech && globalSpeechPhase ? (
    <aside className={`global-speech-bubble phase-${globalSpeechPhase}`} aria-live="polite">
      <span className="global-speech-bubble__status" aria-hidden="true" />
      <div>
        <b>{globalSpeechPhase === "recording"
          ? "团子正在听"
          : globalSpeechPhase === "transcribing"
            ? "团子正在转成文字"
            : globalSpeechPhase === "done"
              ? "已输入当前文本框"
              : "这次没有输入"}</b>
        <p>{globalSpeech.text}</p>
      </div>
    </aside>
  ) : null;

  if (fatalError) {
    return (
      <main className="surface fatal-error">
        <h1>desk-pet 没能醒来</h1>
        <p>{fatalError}</p>
        <button className="button button--primary" type="button" onClick={() => location.reload()}>重试</button>
      </main>
    );
  }

  if (!bootstrap || !runtime || !speech || !tts) {
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
      <Onboarding
        initialConfig={bootstrap.config}
        platform={bootstrap.platform}
        onComplete={finishOnboarding}
      />
    );
  }

  if (view === "chat") {
    return (
      <>
        <ChatPanel
          runtime={runtime}
          speech={speech}
          tts={tts}
          draft={draft}
          images={draftImages}
          onDraftChange={updateDraft}
          onImagesChange={setDraftImages}
          visionEnabled={runtime.visionEnabled}
          onPrepareSpeech={prepareSpeech}
          onStartSpeech={startSpeech}
          onStopSpeech={stopSpeech}
          onCancelSpeech={cancelSpeech}
          onSpeakText={speakText}
          onStopSpeaking={stopSpeaking}
          onClose={() => void transitionToView("pet")}
          onSettings={() => void transitionToView("settings")}
          onStartRuntime={startRuntime}
        />
        {globalSpeechBubble}
      </>
    );
  }

  if (view === "settings") {
    return (
      <>
        <Settings
          initialConfig={bootstrap.config}
          runtime={runtime}
          speech={speech}
          tts={tts}
          onPrepareSpeech={prepareSpeech}
          onImportSpeech={importSpeechModels}
          onPrepareTts={prepareTts}
          onImportTts={importTtsModels}
          onSpeakText={speakText}
          onStopSpeaking={stopSpeaking}
          onClose={() => void transitionToView("pet")}
          onSave={saveSettings}
        />
        {globalSpeechBubble}
      </>
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
        clipMood={speech.phase === "recording" ? "idle" : undefined}
        windowDrag
        onClick={() => void transitionToView("chat")}
      />
      {globalSpeechBubble}
    </main>
  );
}
